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

// ✅ Public + Contact Book endpoints
const {
    exchangeContact,
    listMyContactExchanges,
    deleteMyContactExchange,
} = require("../controllers/publicController");

// ✅ Stripe controller
const {
    subscribeUser,
    cancelSubscription,
    checkSubscriptionStatus,
    syncSubscriptions,
    createBillingPortal,
} = require("../controllers/stripeController");

// ✅ Billing controller
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

// ✅ Claim link (PUBLIC)
router.post("/claim-link", claimLink);

// ✅ Exchange contact (PUBLIC) — visitor submits details from /u/:slug
router.post("/exchange-contact", exchangeContact);

// ✅ Contact Book (PROTECTED) — owner views/deletes exchanges
router.get("/contact-exchanges", requireAuth, listMyContactExchanges);
router.delete("/contact-exchanges/:id", requireAuth, deleteMyContactExchange);

// Register/Login
router.post("/register", registerUser);
router.post("/login", loginUser);

// ✅ PROTECT: profile must reject deleted/stale tokens
router.get("/profile", requireAuth, getProfile);

router.post("/logout", logoutUser);

router.post("/verify-email", verifyEmailCode);
router.post("/resend-code", resendVerificationCode);

router.post("/forgot-password", forgotPassword);
router.post("/reset-password/:token", resetPassword);

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
// ✅ SETTINGS / BILLING ROUTES (PROTECTED)
// ==============================
router.get("/billing/summary", requireAuth, getBillingSummary);
router.get("/billing/invoices", requireAuth, listBillingInvoices);
router.get("/billing/payments", requireAuth, listBillingPayments);

// ==============================
// TRIAL + SYNC ROUTES (PROTECTED)
// ==============================
router.post("/start-trial", requireAuth, startTrial);
router.post("/me/sync-subscriptions", requireAuth, syncSubscriptions);

// ==============================
// CONTACT
// ==============================
router.post("/contact", submitContactForm);

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
