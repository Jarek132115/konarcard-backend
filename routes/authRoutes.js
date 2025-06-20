const express = require('express');
const router = express.Router();

// CORRECTED: This import must point to your existing 'authController' file
// as it now contains ALL your consolidated authentication logic.
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
} = require('../controllers/authController'); // <--- THIS IS THE CRITICAL FIX

// Required models are used directly in the public_profile route within this file.
// Their paths should be correct if your folder structure is:
// backend/
//   controllers/
//   models/
//     user.js
//     BusinessCard.js
//     Service.js
//     Work.js
const User = require('../models/user');
const BusinessCard = require('../models/BusinessCard');
const Service = require('../models/Service');
const Work = require('../models/Work');


// Define Authentication and User-related Routes
router.get('/', test); // Test route
router.post('/register', registerUser);
router.post('/login', loginUser);
router.get('/profile', getProfile);
router.post('/logout', logoutUser); // Ensure this route is POST for security best practices

// Email Verification and Password Reset
router.post('/verify-email', verifyEmailCode);
router.post('/resend-code', resendVerificationCode);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password/:token', resetPassword);

// User Profile Management (using the authenticated user)
router.put('/update-profile', updateProfile);
router.delete('/delete-account', deleteAccount);

// Stripe / Subscription Management
router.post('/subscribe', subscribeUser);
router.post('/cancel-subscription', cancelSubscription);
router.get('/subscription-status', checkSubscriptionStatus);

// Contact Form
router.post('/contact', submitContactForm);

// Route for public business profile (accessible by anyone, uses slug for lookup)
// This route uses the 'User', 'BusinessCard', 'Service', and 'Work' models directly.
router.get('/public_profile/:slug', async (req, res) => {
    try {
        const slug = req.params.slug;

        const user = await User.findOne({ slug });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const [businessCard, services, works] = await Promise.all([
            BusinessCard.findOne({ user: user._id }),
            Service.find({ user: user._id }),
            Work.find({ user: user._id }),
        ]);

        res.json({
            user: {
                name: user.name,
                avatar: user.avatar || null,
                bio: user.bio || '',
                job_title: user.job_title || '',
            },
            businessCard,
            services,
            works,
        });
    } catch (err) {
        console.error('Public profile fetch error:', err);
        res.status(500).json({ error: 'Server error fetching public profile' });
    }
});

module.exports = router;