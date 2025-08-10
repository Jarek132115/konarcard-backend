const express = require('express');
const router = express.Router();
const multer = require('multer');

const authenticateToken = require('../middleware/authenticateToken');

const {
    createOrUpdateBusinessCard,
    getBusinessCardByUserId,
} = require('../controllers/businessCardController');

const storage = multer.memoryStorage();
const upload = multer({ storage }).fields([
    { name: 'cover_photo', maxCount: 1 },
    { name: 'avatar', maxCount: 1 },
    { name: 'works', maxCount: 10 },
    { name: 'existing_works' },
]);

router.post('/create_business_card', authenticateToken, upload, createOrUpdateBusinessCard);

router.get('/my_card', authenticateToken, getBusinessCardByUserId);

router.get('/by_username/:username', async (req, res) => {
    try {
        const User = require('../models/user');
        const BusinessCard = require('../models/BusinessCard');
        const { username } = req.params;

        const user = await User.findOne({ username: username.toLowerCase().trim() });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Corrected: Populate with subscription info
        const card = await BusinessCard.findOne({ user: user._id })
            .populate({
                path: 'user',
                select: 'qrCode username profileUrl isSubscribed trialExpires', // Include these fields
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
            isSubscribed: card.user?.isSubscribed, // Add this
            trialExpires: card.user?.trialExpires, // Add this
        };

        res.status(200).json(responseCard);
    } catch (err) {
        console.error('Error fetching business card by username:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;