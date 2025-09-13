// routes/auth.js
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

// ✅ correct import name here
const { listOrders } = require('../controllers/orderController');

router.use(express.json({ limit: '50mb' }));
router.use(express.urlencoded({ extended: true, limit: '50mb' }));

router.get('/', test);
router.post('/register', registerUser);
router.post('/login', loginUser);
router.post('/verify-email', verifyEmailCode);
router.post('/resend-code', resendVerificationCode);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password/:token', resetPassword);

const authenticateToken = require('../middleware/authenticateToken');

router.get('/profile', authenticateToken, getProfile);
router.put('/update-profile', authenticateToken, updateProfile);
router.delete('/delete-account', authenticateToken, deleteAccount);
router.post('/logout', authenticateToken, logoutUser);

// Subscriptions
router.post('/subscribe', authenticateToken, subscribeUser);
router.post('/cancel-subscription', authenticateToken, cancelSubscription);
router.get('/subscription-status', authenticateToken, checkSubscriptionStatus);

// Trials
router.post('/trial/start', authenticateToken, startTrial);
router.post('/start-trial', authenticateToken, startTrial);

// Contact
router.post('/contact', submitContactForm);

// One-time card checkout
router.post('/checkout/create-checkout-session', authenticateToken, createCardCheckoutSession);

// 🆕 Orders — fetch the logged-in user's orders
router.get('/me/orders', authenticateToken, listOrders);

module.exports = router;
