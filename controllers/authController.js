// backend/controllers/authController.js
const { hashPassword, comparePassword, getTokenFromReq } = require("../helpers/auth");
const User = require("../models/user");
const BusinessCard = require("../models/BusinessCard");
const jwt = require("jsonwebtoken");
const QRCode = require("qrcode");
const sendEmail = require("../utils/SendEmail");
const { verificationEmailTemplate, passwordResetTemplate } = require("../utils/emailTemplates");
const crypto = require("crypto");
const uploadToS3 = require("../utils/uploadToS3");

const FRONTEND_PROFILE_DOMAIN =
    process.env.PUBLIC_PROFILE_DOMAIN || "https://www.konarcard.com";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

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
    const fileKey = `qr-codes/${userId}/${safeSlug}-${Date.now()}.png`;
    const qrCodeUrl = await uploadToS3(qrBuffer, fileKey);
    return qrCodeUrl;
};

// TEST
const test = (req, res) => res.json("test is working");

/**
 * ✅ CLAIM LINK (NEW MEANING)
 * Frontend "username" = FIRST PROFILE SLUG.
 *
 * - If NOT logged in: availability check only.
 * - If logged in: create FIRST BusinessCard if none, generate QR for it.
 */
const claimLink = async (req, res) => {
    try {
        const raw = (req.body.username || "").trim().toLowerCase();
        if (!raw) return res.status(400).json({ error: "Username is required" });

        const profileSlug = safeProfileSlug(raw);
        if (!profileSlug || profileSlug.length < 3) {
            return res.status(400).json({ error: "Link name must be at least 3 characters" });
        }

        // Global availability check
        const taken = await BusinessCard.findOne({ profile_slug: profileSlug }).select("_id");
        if (taken) return res.status(409).json({ error: "Username already taken" });

        const token = getTokenFromReq(req);

        // No auth => just availability
        if (!token) {
            return res.json({ success: true, available: true, username: profileSlug });
        }

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch {
            return res.status(401).json({ error: "Invalid token" });
        }

        const user = await User.findById(decoded.id);
        if (!user) return res.status(401).json({ error: "User not found" });

        // Keep for account/UI only (routing uses /u/:slug)
        user.username = profileSlug;
        user.slug = profileSlug;
        user.profileUrl = buildPublicProfileUrl(profileSlug);

        // Create FIRST profile if none
        const existingCount = await BusinessCard.countDocuments({ user: user._id });

        if (existingCount === 0) {
            await BusinessCard.create({
                user: user._id,
                profile_slug: profileSlug,
                template_id: "template-1",
                full_name: user.name || "",
            });
        }

        // Ensure QR exists for this slug/profile
        const target = await BusinessCard.findOne({ profile_slug: profileSlug, user: user._id });
        if (target) {
            const qrUrl = await generateAndUploadProfileQr(user._id, profileSlug);
            if (qrUrl) {
                target.qr_code_url = qrUrl;
                await target.save();
                user.qrCodeUrl = qrUrl; // legacy “main QR”
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

        // Username input is first profile slug
        const desiredSlug = safeProfileSlug(username);
        if (!desiredSlug || desiredSlug.length < 3) {
            return res.status(400).json({ error: "Username must be at least 3 characters." });
        }

        const existingEmail = await User.findOne({ email: cleanEmail });
        if (existingEmail) {
            return res.json({ error: "This email is already registered. Please log in." });
        }

        // Global slug uniqueness
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
            username: desiredSlug,
            password: hashedPassword,
            profileUrl: buildPublicProfileUrl(desiredSlug),
            isVerified: false,
            verificationCode: code,
            verificationCodeExpires: expires,
            slug: desiredSlug,
            authProvider: "local",
        });

        const card = await BusinessCard.create({
            user: user._id,
            profile_slug: desiredSlug,
            full_name: name || "",
            template_id: "template-1",
        });

        const qrUrl = await generateAndUploadProfileQr(user._id, desiredSlug);
        if (qrUrl) {
            card.qr_code_url = qrUrl;
            await card.save();
            user.qrCodeUrl = qrUrl;
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
    submitContactForm,
};
