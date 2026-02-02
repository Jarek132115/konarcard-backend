// backend/controllers/authController.js
const { hashPassword, comparePassword, getTokenFromReq } = require("../helpers/auth");
const User = require("../models/user");
const BusinessCard = require("../models/BusinessCard");
const jwt = require("jsonwebtoken");
const QRCode = require("qrcode");
const sendEmail = require("../utils/SendEmail");
const { verificationEmailTemplate, passwordResetTemplate } = require("../utils/emailTemplates");
const crypto = require("crypto");
const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const uploadToS3 = require("../utils/uploadToS3");

const FRONTEND_PROFILE_DOMAIN = process.env.PUBLIC_PROFILE_DOMAIN || "https://www.konarcard.com";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

// -------------------------
// Stripe price mapping
// -------------------------
const SUBSCRIPTION_PRICE_MAP = {
    "plus-monthly": process.env.STRIPE_PRICE_PLUS_MONTHLY,
    "plus-quarterly": process.env.STRIPE_PRICE_PLUS_QUARTERLY,
    "plus-yearly": process.env.STRIPE_PRICE_PLUS_YEARLY,

    "teams-monthly": process.env.STRIPE_PRICE_TEAMS_MONTHLY,
    "teams-quarterly": process.env.STRIPE_PRICE_TEAMS_QUARTERLY,
    "teams-yearly": process.env.STRIPE_PRICE_TEAMS_YEARLY,
};

const parsePlanKey = (planKey) => {
    const [plan, interval] = String(planKey || "").split("-");
    if (!["plus", "teams"].includes(plan)) return null;
    if (!["monthly", "quarterly", "yearly"].includes(interval)) return null;
    return { plan, interval };
};

const signToken = (user) => {
    return jwt.sign(
        { email: user.email, id: user._id, name: user.name },
        process.env.JWT_SECRET,
        { expiresIn: "30d" }
    );
};

const toSafeUser = (userDoc) => {
    const u = userDoc?.toObject ? userDoc.toObject() : userDoc;
    if (!u) return null;
    delete u.password;
    delete u.verificationCode;
    delete u.verificationCodeExpires;
    delete u.resetToken;
    delete u.resetTokenExpires;
    return u;
};

/**
 * Slug rules for public profile URLs:
 * - Global: https://www.konarcard.com/u/:slug
 * - Must be a-z 0-9 hyphen
 */
const safeProfileSlug = (raw) => {
    const s = String(raw || "").trim().toLowerCase();
    if (!s) return "";
    const cleaned = s
        .replace(/_/g, "-")
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
    return cleaned;
};

const buildPublicProfileUrl = (profileSlug) => {
    const s = safeProfileSlug(profileSlug);
    if (!s) return "";
    return `${FRONTEND_PROFILE_DOMAIN}/u/${s}`;
};

/**
 * Generate QR -> upload to S3 -> return URL
 * Each BusinessCard has its own QR, keyed by its profile_slug.
 */
const generateAndUploadProfileQr = async (userId, profileSlug) => {
    const url = buildPublicProfileUrl(profileSlug);
    if (!url) return "";

    const qrBuffer = await QRCode.toBuffer(url, {
        width: 900,
        margin: 2,
        errorCorrectionLevel: "M",
        color: { dark: "#000000", light: "#ffffff" },
    });

    const safeSlug = safeProfileSlug(profileSlug) || "profile";
    const fileKey = `qr-codes/${userId}/${safeSlug}-${Date.now()}.png`; // unique to avoid caching
    const qrCodeUrl = await uploadToS3(qrBuffer, fileKey);
    return qrCodeUrl;
};

// TEST
const test = (req, res) => res.json("test is working");

/**
 * ✅ CLAIM LINK (NEW MEANING)
 * You enter a "username" on the frontend — we treat that as the FIRST PROFILE SLUG.
 *
 * - If NOT logged in: availability check only for profile_slug global uniqueness.
 * - If logged in: must be valid token + user exists
 *   -> create FIRST BusinessCard with profile_slug = claimed slug (if user has none)
 *   -> generate QR for that profile
 *
 * We keep user.username as an account identifier if you still want it, but URLs use /u/:slug only.
 */
const claimLink = async (req, res) => {
    try {
        const raw = (req.body.username || "").trim().toLowerCase();
        if (!raw) return res.status(400).json({ error: "Username is required" });

        // allow input like old system, but convert to strict profile slug
        const profileSlug = safeProfileSlug(raw);
        if (!profileSlug || profileSlug.length < 3) {
            return res.status(400).json({ error: "Link name must be at least 3 characters" });
        }

        // Global availability check: BusinessCard.profile_slug must be unique platform-wide
        const taken = await BusinessCard.findOne({ profile_slug: profileSlug }).select("_id");
        if (taken) return res.status(409).json({ error: "Username already taken" });

        const token = getTokenFromReq(req);

        // Availability check (no auth) — frontend uses this as user types
        if (!token) {
            return res.json({ success: true, available: true, username: profileSlug });
        }

        // Token present => must be valid
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch {
            return res.status(401).json({ error: "Invalid token" });
        }

        // Token valid => user must exist
        const user = await User.findById(decoded.id);
        if (!user) {
            return res.status(401).json({ error: "User not found" });
        }

        // Optional: store username on user (kept for UI/account, not routing)
        user.username = profileSlug;
        user.slug = profileSlug; // legacy field
        user.profileUrl = buildPublicProfileUrl(profileSlug); // legacy field (now /u/:slug)

        // If user has no profiles yet, create the first one using this slug
        const existingCount = await BusinessCard.countDocuments({ user: user._id });
        let card = null;

        if (existingCount === 0) {
            card = await BusinessCard.create({
                user: user._id,
                profile_slug: profileSlug,
                template_id: "template-1",
                full_name: user.name || "",
            });
        }

        // Ensure QR exists for the claimed slug profile (either just created or not)
        const target = await BusinessCard.findOne({ profile_slug: profileSlug, user: user._id });
        if (target) {
            const qrUrl = await generateAndUploadProfileQr(user._id, profileSlug);
            if (qrUrl) {
                target.qr_code_url = qrUrl;
                await target.save();
                user.qrCodeUrl = qrUrl; // legacy field for “main QR”
            }
        }

        await user.save();
        return res.json({ success: true, user: toSafeUser(user) });
    } catch (err) {
        console.error("claimLink error:", err);
        return res.status(500).json({ error: "Failed to claim link" });
    }
};

// REGISTER
const registerUser = async (req, res) => {
    try {
        const { name, email, username, password, confirmPassword } = req.body;

        if (!name || !email || !username || !password) {
            return res.status(400).json({ error: "All fields are required." });
        }
        if (confirmPassword && password !== confirmPassword) {
            return res.status(400).json({ error: "Passwords do not match." });
        }

        const cleanEmail = email.trim().toLowerCase();

        // Use username input as first profile slug
        const desiredSlug = safeProfileSlug(username);
        if (!desiredSlug || desiredSlug.length < 3) {
            return res.status(400).json({ error: "Username must be at least 3 characters." });
        }

        // User email uniqueness
        const existingEmail = await User.findOne({ email: cleanEmail });
        if (existingEmail) {
            return res.json({ error: "This email is already registered. Please log in." });
        }

        // Global slug uniqueness for first profile
        const slugTaken = await BusinessCard.findOne({ profile_slug: desiredSlug }).select("_id");
        if (slugTaken) {
            return res.status(400).json({ error: "Username already taken. Please choose another." });
        }

        const hashedPassword = await hashPassword(password);

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = Date.now() + 10 * 60 * 1000;

        const user = await User.create({
            name,
            email: cleanEmail,
            username: desiredSlug, // kept for account/UI
            password: hashedPassword,
            profileUrl: buildPublicProfileUrl(desiredSlug), // legacy field
            isVerified: false,
            verificationCode: code,
            verificationCodeExpires: expires,
            slug: desiredSlug, // legacy field
            authProvider: "local",
        });

        // Create FIRST BusinessCard with the slug
        const card = await BusinessCard.create({
            user: user._id,
            profile_slug: desiredSlug,
            full_name: name || "",
            template_id: "template-1",
        });

        // QR for first profile
        const qrUrl = await generateAndUploadProfileQr(user._id, desiredSlug);
        if (qrUrl) {
            card.qr_code_url = qrUrl;
            await card.save();
            user.qrCodeUrl = qrUrl; // legacy
            await user.save();
        }

        const html = verificationEmailTemplate(name, code);
        await sendEmail(cleanEmail, "Verify Your Email", html);

        return res.json({ success: true, message: "Verification email sent" });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Registration failed. Try again." });
    }
};

// VERIFY EMAIL
const verifyEmailCode = async (req, res) => {
    try {
        const { email, code } = req.body;
        const user = await User.findOne({ email: email.trim().toLowerCase() });

        if (!user) return res.json({ error: "User not found" });
        if (user.isVerified) return res.json({ error: "Email already verified" });
        if (user.verificationCode !== code) return res.json({ error: "Invalid verification code" });
        if (user.verificationCodeExpires < Date.now()) return res.json({ error: "Code has expired" });

        user.isVerified = true;
        user.verificationCode = undefined;
        user.verificationCodeExpires = undefined;
        await user.save();

        return res.json({ success: true, message: "Email verified successfully" });
    } catch (err) {
        console.log(err);
        return res.status(500).json({ error: "Verification failed" });
    }
};

// RESEND VERIFICATION CODE
const resendVerificationCode = async (req, res) => {
    try {
        const { email } = req.body;
        const user = await User.findOne({ email: email.trim().toLowerCase() });

        if (!user) return res.json({ error: "User not found" });
        if (user.isVerified) return res.json({ error: "Email already verified" });

        const newCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = Date.now() + 10 * 60 * 1000;

        user.verificationCode = newCode;
        user.verificationCodeExpires = expires;
        await user.save();

        const html = verificationEmailTemplate(user.name, newCode);
        await sendEmail(user.email, "Your New Verification Code", html);

        return res.json({ success: true, message: "Verification code resent" });
    } catch (err) {
        console.log(err);
        return res.status(500).json({ error: "Could not resend code" });
    }
};

// LOGIN
const loginUser = async (req, res) => {
    try {
        const { email, password } = req.body;
        const cleanEmail = (email || "").trim().toLowerCase();

        const user = await User.findOne({ email: cleanEmail });
        if (!user) return res.json({ error: "No user found" });

        const match = await comparePassword(password, user.password);
        if (!match) return res.json({ error: "Passwords don’t match" });

        if (!user.isVerified) {
            const newCode = Math.floor(100000 + Math.random() * 900000).toString();
            const expires = Date.now() + 10 * 60 * 1000;

            user.verificationCode = newCode;
            user.verificationCodeExpires = expires;
            await user.save();

            const html = verificationEmailTemplate(user.name, newCode);
            await sendEmail(user.email, "Verify Your Email", html);

            return res.json({
                error: "Please verify your email before logging in.",
                resend: true,
            });
        }

        const token = signToken(user);

        // Optional cookie (frontend uses Bearer token anyway)
        res.cookie("token", token, { httpOnly: true, sameSite: "lax" });

        return res.json({ token, user: toSafeUser(user) });
    } catch (error) {
        console.log(error);
        return res.status(500).json({ error: "Login failed" });
    }
};

// FORGOT PASSWORD
const forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        const cleanEmail = (email || "").trim().toLowerCase();

        const user = await User.findOne({ email: cleanEmail });
        if (!user) return res.json({ error: "User not found" });

        const token = crypto.randomBytes(32).toString("hex");
        user.resetToken = token;
        user.resetTokenExpires = Date.now() + 60 * 60 * 1000;
        await user.save();

        const resetLink = `${FRONTEND_URL}/reset-password/${token}`;
        const html = passwordResetTemplate(user.name, resetLink);
        await sendEmail(user.email, "Reset Your Password", html);

        return res.json({ success: true, message: "Password reset email sent" });
    } catch (err) {
        console.log(err);
        return res.status(500).json({ error: "Could not send password reset email" });
    }
};

// RESET PASSWORD
const resetPassword = async (req, res) => {
    try {
        const { token } = req.params;
        const { password } = req.body;

        const user = await User.findOne({
            resetToken: token,
            resetTokenExpires: { $gt: Date.now() },
        });

        if (!user) return res.json({ error: "Invalid or expired token" });

        const hashed = await hashPassword(password);
        user.password = hashed;
        user.resetToken = undefined;
        user.resetTokenExpires = undefined;
        await user.save();

        return res.json({ success: true, message: "Password updated successfully" });
    } catch (err) {
        console.log(err);
        return res.status(500).json({ error: "Password reset failed" });
    }
};

// PROFILE (PROTECTED BY requireAuth)
const getProfile = async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });
        return res.json({ data: toSafeUser(req.user) });
    } catch (err) {
        console.error("getProfile error:", err);
        return res.status(500).json({ error: "Failed to load profile" });
    }
};

// UPDATE PROFILE (PROTECTED BY requireAuth)
const updateProfile = async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });

        const { name, email, bio, job_title } = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            req.user._id,
            { name, email, bio, job_title },
            { new: true, runValidators: true }
        ).select("-password");

        if (!updatedUser) return res.status(401).json({ error: "Unauthorized" });

        return res.json({ success: true, user: toSafeUser(updatedUser) });
    } catch (err) {
        console.error("updateProfile error:", err);
        return res.status(500).json({ error: "Failed to update profile" });
    }
};

// DELETE ACCOUNT (PROTECTED BY requireAuth)
const deleteAccount = async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });

        await User.findByIdAndDelete(req.user._id);
        res.clearCookie("token");
        return res.json({ success: true });
    } catch (err) {
        console.error("deleteAccount error:", err);
        return res.status(500).json({ error: "Failed to delete account" });
    }
};

// LOGOUT
const logoutUser = (req, res) => {
    res.clearCookie("token");
    res.json({ message: "Logged out successfully" });
};

// ----------------------------------------------------
// STRIPE: Create Subscription Checkout Session
// (PROTECTED BY requireAuth)
// ----------------------------------------------------
const subscribeUser = async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });

        const user = req.user; // hydrated by requireAuth

        // ✅ must have at least 1 profile before checkout
        const profileCount = await BusinessCard.countDocuments({ user: user._id });
        if (profileCount <= 0) {
            return res.status(400).json({
                error: "You must create a profile before subscribing.",
                code: "PROFILE_REQUIRED",
            });
        }

        const { planKey, returnUrl } = req.body;

        const parsed = parsePlanKey(planKey);
        if (!parsed) return res.status(400).json({ error: "Invalid planKey" });

        const priceId = SUBSCRIPTION_PRICE_MAP[planKey];
        if (!priceId) return res.status(500).json({ error: "Price not configured on server" });

        const baseReturn =
            typeof returnUrl === "string" && returnUrl.trim()
                ? returnUrl.trim()
                : `${FRONTEND_URL}/myprofile?subscribed=1`;

        const successUrl = baseReturn.includes("?")
            ? `${baseReturn}&session_id={CHECKOUT_SESSION_ID}`
            : `${baseReturn}?session_id={CHECKOUT_SESSION_ID}`;

        const cancelUrl = `${FRONTEND_URL}/pricing`;

        // ✅ Teams quantity billing: start quantity = current number of profiles (min 1)
        const quantity =
            parsed.plan === "teams" ? Math.max(1, profileCount) : 1;

        const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            payment_method_types: ["card"],
            line_items: [{ price: priceId, quantity }],
            ...(user.stripeCustomerId ? { customer: user.stripeCustomerId } : { customer_email: user.email }),
            success_url: successUrl,
            cancel_url: cancelUrl,
            metadata: {
                userId: String(user._id),
                plan: parsed.plan,
                interval: parsed.interval,
                planKey,
                teamsQuantityAtCheckout: String(quantity),
            },
        });

        return res.json({ url: session.url });
    } catch (err) {
        console.error("subscribeUser error:", err);
        return res.status(500).json({ error: "Failed to start subscription" });
    }
};

// ----------------------------------------------------
// STRIPE: Cancel Subscription (cancel at period end)
// (PROTECTED BY requireAuth)
// ----------------------------------------------------
const cancelSubscription = async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });

        const user = req.user;

        if (user.stripeSubscriptionId) {
            await stripe.subscriptions.update(user.stripeSubscriptionId, {
                cancel_at_period_end: true,
            });

            await User.findByIdAndUpdate(user._id, {
                $set: { subscriptionStatus: "cancelling" },
            });

            return res.json({ success: true, message: "Subscription will cancel at period end" });
        }

        if (!user.stripeCustomerId) return res.status(400).json({ error: "No subscription found" });

        const subscriptions = await stripe.subscriptions.list({
            customer: user.stripeCustomerId,
            status: "active",
            limit: 1,
        });

        if (!subscriptions.data.length) return res.status(400).json({ error: "No active subscription found" });

        await stripe.subscriptions.update(subscriptions.data[0].id, {
            cancel_at_period_end: true,
        });

        await User.findByIdAndUpdate(user._id, {
            $set: { stripeSubscriptionId: subscriptions.data[0].id, subscriptionStatus: "cancelling" },
        });

        return res.json({ success: true, message: "Subscription will cancel at period end" });
    } catch (err) {
        console.error("cancelSubscription error:", err);
        return res.status(500).json({ error: "Failed to cancel subscription" });
    }
};

// ----------------------------------------------------
// STRIPE: Subscription status (from DB)
// (PROTECTED BY requireAuth)
// ----------------------------------------------------
const checkSubscriptionStatus = async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });

        const user = req.user;

        return res.json({
            active: !!user.isSubscribed,
            plan: user.plan || "free",
            interval: user.planInterval || "monthly",
            status: user.subscriptionStatus || "free",
            currentPeriodEnd: user.currentPeriodEnd || null,
        });
    } catch (err) {
        console.error("checkSubscriptionStatus error:", err);
        return res.status(500).json({ error: "Failed to load subscription status" });
    }
};

// -------------------------
// TRIAL: Start 14-day trial
// (PROTECTED BY requireAuth)
// -------------------------
const startTrial = async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });

        const user = req.user;

        if (user.isSubscribed) {
            return res.json({
                success: true,
                message: "Already subscribed",
                trialExpires: user.trialExpires || null,
            });
        }

        const now = Date.now();

        if (user.trialExpires && new Date(user.trialExpires).getTime() > now) {
            return res.json({ success: true, message: "Trial already active", trialExpires: user.trialExpires });
        }

        if (user.trialExpires && new Date(user.trialExpires).getTime() <= now) {
            return res.status(400).json({ error: "Trial already started" });
        }

        user.trialExpires = new Date(now + 14 * 24 * 60 * 60 * 1000);
        user.subscriptionStatus = "trialing";
        user.plan = user.plan || "free";
        await user.save();

        return res.json({ success: true, trialExpires: user.trialExpires });
    } catch (err) {
        console.error("startTrial error:", err);
        return res.status(500).json({ error: "Failed to start trial" });
    }
};

// ----------------------------------------------------
// STRIPE: Sync subscription status (best effort)
// (PROTECTED BY requireAuth)
// ----------------------------------------------------
const syncSubscriptions = async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });

        const user = await User.findById(req.user._id);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        if (!user.stripeCustomerId) {
            return res.json({ success: true, synced: false, reason: "no_stripe_customer" });
        }

        const subs = await stripe.subscriptions.list({
            customer: user.stripeCustomerId,
            status: "all",
            limit: 10,
        });

        const active = subs.data.find((s) => ["active", "trialing"].includes(s.status));
        const latest = active || subs.data[0];

        if (!latest) {
            user.isSubscribed = false;
            user.subscriptionStatus = "free";
            user.plan = "free";
            user.stripeSubscriptionId = undefined;
            await user.save();
            return res.json({ success: true, synced: true, isSubscribed: false });
        }

        user.stripeSubscriptionId = latest.id;
        user.subscriptionStatus = latest.status;
        user.isSubscribed = ["active", "trialing"].includes(latest.status);

        if (latest.current_period_end) {
            user.currentPeriodEnd = new Date(latest.current_period_end * 1000);
        }

        await user.save();

        return res.json({
            success: true,
            synced: true,
            isSubscribed: user.isSubscribed,
            subscriptionStatus: user.subscriptionStatus,
            currentPeriodEnd: user.currentPeriodEnd || null,
        });
    } catch (err) {
        console.error("syncSubscriptions error:", err);
        return res.status(500).json({ error: "Failed to sync subscriptions" });
    }
};

// ----------------------------------------------------
// STRIPE: Customer Portal (manage subscription)
// (PROTECTED BY requireAuth)
// ----------------------------------------------------
const createBillingPortal = async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });

        const user = req.user;

        if (!user.stripeCustomerId) {
            return res.status(400).json({ error: "No Stripe customer found for this user" });
        }

        const portalSession = await stripe.billingPortal.sessions.create({
            customer: user.stripeCustomerId,
            return_url: `${FRONTEND_URL}/myprofile`,
        });

        return res.json({ url: portalSession.url });
    } catch (err) {
        console.error("createBillingPortal error:", err);
        return res.status(500).json({ error: "Failed to create billing portal session" });
    }
};

// CONTACT FORM
const submitContactForm = async (req, res) => {
    const { name, email, reason, message } = req.body;

    if (!name || !email || !message || !reason) {
        return res.status(400).json({ error: "All fields are required" });
    }

    const html = `
    <h2>New Contact Message</h2>
    <p><strong>Name:</strong> ${name}</p>
    <p><strong>Email:</strong> ${email}</p>
    <p><strong>Reason:</strong> ${reason}</p>
    <p><strong>Message:</strong><br/>${message}</p>
  `;

    try {
        await sendEmail("supportteam@konarcard.com", `Contact Form: ${reason}`, html);
        return res.json({ success: true, message: "Message sent successfully" });
    } catch (err) {
        console.error("Error sending contact form email:", err);
        return res.status(500).json({ error: "Failed to send message" });
    }
};

module.exports = {
    test,
    claimLink,
    registerUser,
    verifyEmailCode,
    resendVerificationCode,
    loginUser,
    forgotPassword,
    resetPassword,
    getProfile,
    logoutUser,
    updateProfile,
    deleteAccount,
    startTrial,
    syncSubscriptions,
    // Stripe
    subscribeUser,
    cancelSubscription,
    checkSubscriptionStatus,
    createBillingPortal,
    submitContactForm,
};
