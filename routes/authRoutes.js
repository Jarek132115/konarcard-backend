// backend/routes/authRoutes.js
const express = require('express');
const router = express.Router();

const {
    test,
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
    subscribeUser,
    cancelSubscription,
    checkSubscriptionStatus,
    submitContactForm,
    startTrial,
    createCardCheckoutSession,
} = require('../controllers/authController');

const {
    listOrders,
    getOrderById,
    syncSubscriptions,
} = require('../controllers/ordersController');

const authenticateToken = require('../middleware/authenticateToken');

// ---------- Public ----------
router.get('/', test);
router.post('/register', registerUser);
router.post('/login', loginUser);
router.post('/verify-email', verifyEmailCode);
router.post('/resend-code', resendVerificationCode);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password/:token', resetPassword);
router.post('/contact', submitContactForm);

// ---------- Protected (JWT) ----------
router.get('/profile', authenticateToken, getProfile);
router.put('/profile', authenticateToken, updateProfile);
router.delete('/profile', authenticateToken, deleteAccount);
router.post('/logout', authenticateToken, logoutUser);

// Subscriptions
router.post('/subscribe', authenticateToken, subscribeUser);
router.post('/cancel-subscription', authenticateToken, cancelSubscription);

// Status aliases (cover all paths seen in your logs/frontend)
router.get('/subscription-status', authenticateToken, checkSubscriptionStatus);
router.get('/subscription/status', authenticateToken, checkSubscriptionStatus);
router.get('/check-subscription', authenticateToken, checkSubscriptionStatus);

// Trials
router.post('/trial/start', authenticateToken, startTrial);

// One-time card checkout
router.post('/checkout/card', authenticateToken, createCardCheckoutSession);

// Orders
router.get('/me/orders', authenticateToken, listOrders);
router.get('/me/orders/:id', authenticateToken, getOrderById);

// 🔄 Stripe sync — used by the frontend to reflect manual Stripe changes quickly
router.post('/me/sync-subscriptions', authenticateToken, syncSubscriptions);

module.exports = router;
