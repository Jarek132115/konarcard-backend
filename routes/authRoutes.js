// backend/routes/authRoutes.js
const express = require("express");
const passport = require("passport");
const jwt = require("jsonwebtoken");

const User = require("../models/user");
const BusinessCard = require("../models/BusinessCard");
const Service = require("../models/Service");
const Work = require("../models/Work");

const { requireAuth } = require("../helpers/auth"); // ✅ ADD THIS

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

// ✅ PROTECT: profile must reject deleted/stale tokens
router.get("/profile", requireAuth, getProfile);

router.post("/logout", logoutUser);
router.post("/verify-email", verifyEmailCode);
router.post("/resend-code", resendVerificationCode);
router.post("/forgot-password", forgotPassword);

// ✅ PROTECT: profile update/delete must be authenticated
router.put("/update-profile", requireAuth, updateProfile);
router.delete("/delete-account", requireAuth, deleteAccount);

// ==============================
// STRIPE ROUTES (PROTECTED)
// ==============================
router.post("/subscribe", requireAuth, subscribeUser);
router.post("/cancel-subscription", requireAuth, cancelSubscription);
router.get("/subscription-status", requireAuth, checkSubscriptionStatus);
router.post("/billing-portal", requireAuth, createBillingPortal);

// ==============================
// ✅ TRIAL + SYNC ROUTES (PROTECTED)
// ==============================
router.post("/start-trial", requireAuth, startTrial);
router.post("/me/sync-subscriptions", requireAuth, syncSubscriptions);

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

            // ✅ Frontend stores token then continues flow
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

            // ✅ Frontend stores token then continues flow
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
