const express = require('express');
const router = express.Router();
const multer = require('multer');

// Import the authentication middleware
const authenticateToken = require('../middleware/authenticateToken');

// Import the business card controller functions
const {
    createOrUpdateBusinessCard,
    getBusinessCardByUserId,
} = require('../controllers/businessCardController');

// Multer setup - remains in routes as it's route-specific middleware
const storage = multer.memoryStorage();
const upload = multer({ storage }).fields([
    { name: 'cover_photo', maxCount: 1 },
    { name: 'avatar', maxCount: 1 },
    { name: 'work_images', maxCount: 10 },
]);

// POST /api/business-card/create_business_card (Protected and handles file uploads)
// Multer middleware 'upload' runs here before the controller, correctly parsing files.
router.post('/create_business_card', authenticateToken, upload, createOrUpdateBusinessCard);

// GET /api/business-card/my_card (Protected)
// This route now correctly calls the controller, which extracts userId from req.user
router.get('/my_card', authenticateToken, getBusinessCardByUserId);

// GET /api/business-card/by_username/:username (Public - no authentication needed)
router.get('/by_username/:username', async (req, res) => {
    try {
        const User = require('../models/user'); // Re-require here if needed only for this specific route
        const BusinessCard = require('../models/BusinessCard'); // Re-require here if needed only for this specific route
        const { username } = req.params;

        const user = await User.findOne({ username: username.toLowerCase().trim() });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // FIX: Populate the 'user' field when fetching the business card for public view
        const card = await BusinessCard.findOne({ user: user._id })
            .populate({
                path: 'user',
                select: 'qrCode username profileUrl', // Select the fields you need from the User model
            })
            .lean(); // Use .lean() here too

        if (!card) {
            return res.status(404).json({ message: 'Business card not found for this user' });
        }

        // Construct the response object to include user-specific data from the populated user field
        const responseCard = {
            ...card, // All fields from the business card
            qrCodeUrl: card.user?.qrCode || '', // Add qrCodeUrl from populated User model
            username: card.user?.username || '', // Add username from populated User model
            publicProfileUrl: card.user?.profileUrl || '' // Add profileUrl from populated User model
        };

        res.status(200).json(responseCard);
    } catch (err) {
        console.error('Error fetching business card by username:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;