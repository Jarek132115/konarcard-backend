// routes/businessCardRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');

const authenticateToken = require('../middleware/authenticateToken');

const {
    createOrUpdateBusinessCard,
    getBusinessCardByUserId,
    getBusinessCardByUsername,
    resetBusinessCard,
} = require('../controllers/businessCardController');

// Multer memory storage (we upload to S3 ourselves)
const storage = multer.memoryStorage();
const upload = multer({ storage }).fields([
    { name: 'cover_photo', maxCount: 1 },
    { name: 'avatar', maxCount: 1 },
    { name: 'works', maxCount: 10 },
    { name: 'existing_works' },
]);

// Create/Update current user's card
router.post('/create_business_card', authenticateToken, upload, createOrUpdateBusinessCard);

// Get current user's card (private)
router.get('/my_card', authenticateToken, getBusinessCardByUserId);

// Reset (delete) current user's card -> returns success even if nothing existed
router.delete('/my_card', authenticateToken, resetBusinessCard);

// Public: fetch a user's card by @username
router.get('/by_username/:username', async (req, res) => {
    try {
        const User = require('../models/user');
        const BusinessCard = require('../models/BusinessCard');
        const { username } = req.params;

        const user = await User.findOne({ username: username.toLowerCase().trim() });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const card = await BusinessCard.findOne({ user: user._id })
            .populate({
                path: 'user',
                select: 'qrCode username profileUrl isSubscribed trialExpires',
            })
            .lean();

        if (!card) {
            return res.status(404).json({ message: 'Business card not found for this user' });
        }

        const responseCard = {
            ...card,
            qrCodeUrl: card.user?.qrCode || '',
            username: card.user?.username || '',
            publicProfileUrl: card.user?.profileUrl || '',
            isSubscribed: card.user?.isSubscribed,
            trialExpires: card.user?.trialExpires,
        };

        res.status(200).json(responseCard);
    } catch (err) {
        console.error('Error fetching business card by username:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;
