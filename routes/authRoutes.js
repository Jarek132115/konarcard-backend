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
    submitContactForm
} = require('../controllers/authController');

const authenticateToken = require('../middleware/authenticateToken'); 

router.get('/test', test);
router.post('/register', registerUser);
router.post('/login', loginUser);
router.post('/verify-email', verifyEmailCode);
router.post('/resend-code', resendVerificationCode);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password/:token', resetPassword);
router.post('/contact', submitContactForm); 

router.get('/profile', authenticateToken, getProfile);
router.post('/logout', authenticateToken, logoutUser);
router.put('/update-profile', authenticateToken, updateProfile);
router.delete('/delete-account', authenticateToken, deleteAccount);
router.post('/subscribe', authenticateToken, subscribeUser);
router.post('/cancel-subscription', authenticateToken, cancelSubscription);
router.get('/subscription-status', authenticateToken, checkSubscriptionStatus);

module.exports = router;