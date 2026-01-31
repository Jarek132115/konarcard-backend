// backend/routes/authRoutes.js
const express = require("express");
const passport = require("passport");
const jwt = require("jsonwebtoken");

const User = require("../models/user");
const BusinessCard = require("../models/BusinessCard");
const Service = require("../models/Service");
const Work = require("../models/Work");

const {
    test,
    claimLink,
    registerUser,
    loginUser,
    getProfile,
    logoutUser,
    verifyEmailCode,
    resendVerificationCode,
    forgotPassword,
    updateProfile,
    deleteAccount,

    // ✅ Trial + Sync
    startTrial,
    syncSubscriptions,

    // Stripe
    subscribeUser,
    cancelSubscription,
    checkSubscriptionStatus,
    createBillingPortal,

    submitContactForm,
} = require("../controllers/authController");

const router = express.Router();

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

const signToken = (user) => {
    if (!process.env.JWT_SECRET) return null;

    return jwt.sign(
        { email: user.email, id: user._id, name: user.name },
        process.env.JWT_SECRET,
        { expiresIn: "30d" }
    );
};

// ==============================
// BASIC ROUTES
// ==============================
router.get("/", test);

// ✅ Claim link (availability check when not logged in, finalize when logged in)
router.post("/claim-link", claimLink);

router.post("/register", registerUser);
router.post("/login", loginUser);
router.get("/profile", getProfile);
router.post("/logout", logoutUser);
router.post("/verify-email", verifyEmailCode);
router.post("/resend-code", resendVerificationCode);
router.post("/forgot-password", forgotPassword);
router.put("/update-profile", updateProfile);
router.delete("/delete-account", deleteAccount);

// ==============================
// STRIPE ROUTES
// ==============================
router.post("/subscribe", subscribeUser);
router.post("/cancel-subscription", cancelSubscription);
router.get("/subscription-status", checkSubscriptionStatus);
router.post("/billing-portal", createBillingPortal);

// ==============================
// ✅ TRIAL + SYNC ROUTES (NEW)
// ==============================
router.post("/start-trial", startTrial);
router.post("/me/sync-subscriptions", syncSubscriptions);

// ==============================
// CONTACT
// ==============================
router.post("/contact", submitContactForm);

// ==============================
// ✅ GOOGLE OAUTH (Passport)
// ==============================
router.get(
    "/auth/google",
    passport.authenticate("google", {
        scope: ["profile", "email"],
        session: false,
    })
);

router.get(
    "/auth/google/callback",
    passport.authenticate("google", {
        session: false,
        failureRedirect: `${FRONTEND_URL}/login?oauth=google_failed`,
    }),
    (req, res) => {
        try {
            const token = signToken(req.user);

            if (!token) {
                return res.redirect(`${FRONTEND_URL}/login?oauth=missing_jwt_secret`);
            }

            // ✅ Frontend must store token then resume checkout intent (if any)
            return res.redirect(`${FRONTEND_URL}/oauth?token=${encodeURIComponent(token)}`);
        } catch (err) {
            console.error("Google OAuth callback error:", err);
            return res.redirect(`${FRONTEND_URL}/login?oauth=google_failed`);
        }
    }
);

// ==============================
// ✅ FACEBOOK OAUTH (Passport)
// ==============================
router.get(
    "/auth/facebook",
    passport.authenticate("facebook", {
        scope: ["email"],
        session: false,
    })
);

router.get(
    "/auth/facebook/callback",
    passport.authenticate("facebook", {
        session: false,
        failureRedirect: `${FRONTEND_URL}/login?oauth=facebook_failed`,
    }),
    (req, res) => {
        try {
            const token = signToken(req.user);

            if (!token) {
                return res.redirect(`${FRONTEND_URL}/login?oauth=missing_jwt_secret`);
            }

            // ✅ Frontend must store token then resume checkout intent (if any)
            return res.redirect(`${FRONTEND_URL}/oauth?token=${encodeURIComponent(token)}`);
        } catch (err) {
            console.error("Facebook OAuth callback error:", err);
            return res.redirect(`${FRONTEND_URL}/login?oauth=facebook_failed`);
        }
    }
);

// ==============================
// PUBLIC PROFILE (by slug)
// ==============================
router.get("/public_profile/:slug", async (req, res) => {
    try {
        const slug = req.params.slug;

        const user = await User.findOne({ slug });
        if (!user) return res.status(404).json({ error: "User not found" });

        const [businessCard, services, works] = await Promise.all([
            BusinessCard.findOne({ user: user._id }),
            Service.find({ user: user._id }),
            Work.find({ user: user._id }),
        ]);

        res.json({
            user: {
                name: user.name,
                avatar: user.avatar || null,
                bio: user.bio || "",
                job_title: user.job_title || "",
            },
            businessCard,
            services,
            works,
        });
    } catch (err) {
        console.error("Public profile fetch error:", err);
        res.status(500).json({ error: "Server error fetching profile" });
    }
});

module.exports = router;
