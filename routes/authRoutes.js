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

const { listOrders } = require('../controllers/orderController');
const authenticateToken = require('../middleware/authenticateToken');

// Public
router.get('/', test);
router.post('/register', registerUser);
router.post('/login', loginUser);
router.post('/verify-email', verifyEmailCode);
router.post('/resend-code', resendVerificationCode);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password/:token', resetPassword);
router.post('/contact', submitContactForm);

// Protected
router.get('/profile', authenticateToken, getProfile);
router.put('/profile', authenticateToken, updateProfile);
router.delete('/profile', authenticateToken, deleteAccount);
router.post('/logout', authenticateToken, logoutUser);

// Subscriptions
router.post('/subscribe', authenticateToken, subscribeUser);
router.post('/cancel-subscription', authenticateToken, cancelSubscription);
router.get('/subscription-status', authenticateToken, checkSubscriptionStatus);

// Trials
router.post('/trial/start', authenticateToken, startTrial);

// One-time card checkout
router.post('/checkout/card', authenticateToken, createCardCheckoutSession);

// Orders
router.get('/me/orders', authenticateToken, listOrders);

module.exports = router;
