// backend/routes/authRoutes.js
const User = require('../models/user');
const BusinessCard = require('../models/BusinessCard');
const Service = require('../models/Service');
const Work = require('../models/Work');
const express = require('express');
const passport = require('passport');
const jwt = require('jsonwebtoken');

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
    updateProfile,
    deleteAccount,
    subscribeUser,
    cancelSubscription,
    checkSubscriptionStatus,
    submitContactForm,
} = require('../controllers/authController');

const router = express.Router();

router.get('/', test);

// ✅ Claim link (availability check when not logged in, finalize when logged in)
router.post('/claim-link', claimLink);

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

/* ==============================
   ✅ GOOGLE OAUTH (Passport)
   ============================== */

// Start Google OAuth
router.get(
    '/auth/google',
    passport.authenticate('google', {
        scope: ['profile', 'email'],
        session: false,
    })
);

// Callback URL (must match Google Cloud console redirect URI)
router.get(
    '/auth/google/callback',
    passport.authenticate('google', {
        session: false,
        failureRedirect: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/login`,
    }),
    async (req, res) => {
        try {
            const user = req.user;

            if (!process.env.JWT_SECRET) {
                return res.redirect(
                    `${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?oauth=missing_jwt_secret`
                );
            }

            const token = jwt.sign(
                { id: user._id, email: user.email },
                process.env.JWT_SECRET,
                { expiresIn: '30d' }
            );

            const frontend = process.env.FRONTEND_URL || 'http://localhost:5173';
            return res.redirect(`${frontend}/oauth?token=${encodeURIComponent(token)}`);
        } catch (err) {
            console.error('OAuth callback error:', err);
            const frontend = process.env.FRONTEND_URL || 'http://localhost:5173';
            return res.redirect(`${frontend}/login?oauth=failed`);
        }
    }
);

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
