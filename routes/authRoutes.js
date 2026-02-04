// backend/routes/authRoutes.js
const express = require("express");
const passport = require("passport");
const jwt = require("jsonwebtoken");

const { requireAuth } = require("../helpers/auth");

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
    resetPassword,
    updateProfile,
    deleteAccount,
    startTrial,
    submitContactForm,
} = require("../controllers/authController");

// ✅ NEW: Public interactions (exchange contact)
const { exchangeContact } = require("../controllers/publicController");

// ✅ Stripe logic lives in its own controller now
const {
    subscribeUser,
    cancelSubscription,
    checkSubscriptionStatus,
    syncSubscriptions,
    createBillingPortal,
} = require("../controllers/stripeController");

// ✅ Settings/Billing controllers live in their own file now
const {
    getBillingSummary,
    listBillingInvoices,
    listBillingPayments,
} = require("../controllers/billingController");

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

// ✅ Claim link (PUBLIC) — must work before login/register.
// Some deployed builds call /api/claim-link, so we support both.
router.post("/claim-link", claimLink);
router.post("/api/claim-link", claimLink);

// ✅ NEW: Exchange contact (PUBLIC)
// Visitor submits their details on /u/:slug page
router.post("/exchange-contact", exchangeContact);
router.post("/api/exchange-contact", exchangeContact);

// Register/Login — support both / and /api variants to avoid deploy mismatches.
router.post("/register", registerUser);
router.post("/api/register", registerUser);

router.post("/login", loginUser);
router.post("/api/login", loginUser);

// ✅ PROTECT: profile must reject deleted/stale tokens
router.get("/profile", requireAuth, getProfile);
router.get("/api/profile", requireAuth, getProfile);

router.post("/logout", logoutUser);
router.post("/api/logout", logoutUser);

router.post("/verify-email", verifyEmailCode);
router.post("/api/verify-email", verifyEmailCode);

router.post("/resend-code", resendVerificationCode);
router.post("/api/resend-code", resendVerificationCode);

router.post("/forgot-password", forgotPassword);
router.post("/api/forgot-password", forgotPassword);

router.post("/reset-password/:token", resetPassword);
router.post("/api/reset-password/:token", resetPassword);

// ✅ PROTECT: profile update/delete must be authenticated
router.put("/update-profile", requireAuth, updateProfile);
router.put("/api/update-profile", requireAuth, updateProfile);

router.delete("/delete-account", requireAuth, deleteAccount);
router.delete("/api/delete-account", requireAuth, deleteAccount);

// ==============================
// STRIPE ROUTES (PROTECTED)
// ==============================
router.post("/subscribe", requireAuth, subscribeUser);
router.post("/api/subscribe", requireAuth, subscribeUser);

router.post("/cancel-subscription", requireAuth, cancelSubscription);
router.post("/api/cancel-subscription", requireAuth, cancelSubscription);

router.get("/subscription-status", requireAuth, checkSubscriptionStatus);
router.get("/api/subscription-status", requireAuth, checkSubscriptionStatus);

router.post("/billing-portal", requireAuth, createBillingPortal);
router.post("/api/billing-portal", requireAuth, createBillingPortal);

// ==============================
// ✅ SETTINGS / BILLING ROUTES (PROTECTED)
// ==============================
router.get("/billing/summary", requireAuth, getBillingSummary);
router.get("/api/billing/summary", requireAuth, getBillingSummary);

router.get("/billing/invoices", requireAuth, listBillingInvoices);
router.get("/api/billing/invoices", requireAuth, listBillingInvoices);

router.get("/billing/payments", requireAuth, listBillingPayments);
router.get("/api/billing/payments", requireAuth, listBillingPayments);

// ==============================
// TRIAL + SYNC ROUTES (PROTECTED)
// ==============================
router.post("/start-trial", requireAuth, startTrial);
router.post("/api/start-trial", requireAuth, startTrial);

router.post("/me/sync-subscriptions", requireAuth, syncSubscriptions);
router.post("/api/me/sync-subscriptions", requireAuth, syncSubscriptions);

// ==============================
// CONTACT
// ==============================
router.post("/contact", submitContactForm);
router.post("/api/contact", submitContactForm);

// ==============================
// GOOGLE OAUTH (Passport)
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

            return res.redirect(`${FRONTEND_URL}/oauth?token=${encodeURIComponent(token)}`);
        } catch (err) {
            console.error("Google OAuth callback error:", err);
            return res.redirect(`${FRONTEND_URL}/login?oauth=google_failed`);
        }
    }
);

// ==============================
// FACEBOOK OAUTH (Passport)
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

            return res.redirect(`${FRONTEND_URL}/oauth?token=${encodeURIComponent(token)}`);
        } catch (err) {
            console.error("Facebook OAuth callback error:", err);
            return res.redirect(`${FRONTEND_URL}/login?oauth=facebook_failed`);
        }
    }
);

module.exports = router;
