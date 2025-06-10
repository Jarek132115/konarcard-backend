const User = require('../models/user');
const BusinessCard = require('../models/BusinessCard'); 
const Service = require('../models/service');
const Work = require('../models/work');
const express = require('express');

const {
    test,
    registerUser,
    loginUser,
    getProfile,
    logoutUser,
    verifyEmailCode,
    resendVerificationCode,
    forgotPassword,
    updateProfile,
    deleteAccount,
    subscribeUser,
    cancelSubscription,
    checkSubscriptionStatus,
    submitContactForm,
} = require('../controllers/authController');

const router = express.Router();

router.get('/', test);
router.post('/register', registerUser);
router.post('/login', loginUser);
router.get('/profile', getProfile);
router.post('/logout', logoutUser);
router.post('/verify-email', verifyEmailCode);
router.post('/resend-code', resendVerificationCode);
router.post('/forgot-password', forgotPassword);
router.put('/update-profile', updateProfile);
router.delete('/delete-account', deleteAccount);
router.post('/subscribe', subscribeUser);
router.post('/cancel-subscription', cancelSubscription);
router.get('/subscription-status', checkSubscriptionStatus);
router.post('/contact', submitContactForm);
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
        res.status(500).json({ error: 'Server error fetching profile' });
    }
});

module.exports = router;
