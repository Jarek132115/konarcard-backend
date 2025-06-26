// backend/routes/authRoutes.js
const express = require('express');
const router = express.Router();
// CORS is handled globally in index.js
const { test, registerUser, loginUser, getProfile, logoutUser, verifyEmailCode, resendVerificationCode, forgotPassword, resetPassword, updateProfile, deleteAccount, subscribeUser, cancelSubscription, checkSubscriptionStatus, submitContactForm } = require('../controllers/authController');

// CRITICAL FIX: Add body parsers specifically for auth routes here.
// These routes expect application/json or application/x-www-form-urlencoded.
router.use(express.json({ limit: '50mb' }));
router.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Auth related routes
router.get('/', test); // test route
router.post('/register', registerUser);
router.post('/login', loginUser);
router.post('/verify-email', verifyEmailCode);
router.post('/resend-code', resendVerificationCode);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password/:token', resetPassword);

// Protected routes (middleware required)
const authenticateToken = require('../middleware/authenticateToken');
router.get('/profile', authenticateToken, getProfile);
router.put('/update-profile', authenticateToken, updateProfile); // PUT for updates
router.delete('/delete-account', authenticateToken, deleteAccount);
router.post('/logout', authenticateToken, logoutUser); // POST for logout

// Stripe related routes
router.post('/subscribe', authenticateToken, subscribeUser); // POST for new subscriptions
router.post('/cancel-subscription', authenticateToken, cancelSubscription); // POST to cancel subscription
// FIX: Added authenticateToken middleware to /subscription-status route
router.get('/subscription-status', authenticateToken, checkSubscriptionStatus);

// Contact form route (assuming submitContactForm is in authController, otherwise it'd be in contactRoutes)
router.post('/contact', submitContactForm);

module.exports = router;