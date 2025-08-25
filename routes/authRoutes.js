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
    startTrial
} = require('../controllers/authController');

router.use(express.json({ limit: '50mb' }));
router.use(express.urlencoded({ extended: true, limit: '50mb' }));

router.get('/', test);
router.post('/register', registerUser);
router.post('/login', loginUser);
router.post('/verify-email', verifyEmailCode);
router.post('/resend-code', resendVerificationCode);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password/:token', resetPassword);

// Use the actual middleware file (auth.js)
const authenticateToken = require('../middleware/auth');

router.get('/profile', authenticateToken, getProfile);
router.put('/update-profile', authenticateToken, updateProfile);
router.delete('/delete-account', authenticateToken, deleteAccount);
router.post('/logout', authenticateToken, logoutUser);

router.post('/subscribe', authenticateToken, subscribeUser);
router.post('/cancel-subscription', authenticateToken, cancelSubscription);
router.get('/subscription-status', authenticateToken, checkSubscriptionStatus);

// Trial endpoints
router.post('/trial/start', authenticateToken, startTrial);     // <-- matches frontend
router.post('/start-trial', authenticateToken, startTrial);     // <-- backward compatible

router.post('/contact', submitContactForm);

module.exports = router;
