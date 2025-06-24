const express = require('express');
const router = express.Router();
const multer = require('multer');
const BusinessCard = require('../models/BusinessCard');
const User = require('../models/user');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
require('dotenv').config(); // Load environment variables

// Import the authentication middleware
const authenticateToken = require('../middleware/authenticateToken');

// Import the centralized uploadToS3 utility
const uploadToS3 = require('../utils/uploadToS3'); // THIS IS THE CORRECT IMPORT FOR THE UTILITY

// Multer setup (remains the same)
const storage = multer.memoryStorage();
const upload = multer({ storage }).fields([
    { name: 'cover_photo', maxCount: 1 },
    { name: 'avatar', maxCount: 1 },
    { name: 'work_images', maxCount: 10 },
]);

// POST /api/business-card/create_business_card (Protected and handles file uploads)
router.post('/create_business_card', authenticateToken, upload, async (req, res) => {
    try {
        // User ID comes from req.user.id set by authenticateToken middleware
        const user = req.user.id;

        const {
            business_card_name,
            page_theme,
            style,
            main_heading,
            sub_heading,
            bio,
            job_title,
            full_name,
            services,
            reviews,
            existing_works, // These are existing S3 URLs passed from frontend
            cover_photo_removed, // Flag from frontend if cover photo was removed
            avatar_removed,      // Flag from frontend if avatar was removed
            contact_email,
            phone_number,
        } = req.body;

        if (!user) {
            return res.status(401).json({ message: 'Unauthorized: User ID not found in token' });
        }

        let parsedServices = [];
        let parsedReviews = [];

        try {
            parsedServices = typeof services === 'string' ? JSON.parse(services) : Array.isArray(services) ? services : [];
        } catch (err) {
            console.warn('Invalid services JSON. Defaulting to empty array. Error:', err);
        }

        try {
            parsedReviews = typeof reviews === 'string' ? JSON.parse(reviews) : Array.isArray(reviews) ? reviews : [];
        } catch (err) {
            console.warn('Invalid reviews JSON. Defaulting to empty array. Error:', err);
        }

        let coverPhotoUrl = null;
        let avatarUrl = null;
        let workImageUrls = [];

        // If existing_works are provided, filter out any temporary blob URLs and keep valid S3 URLs
        if (existing_works) {
            const existingWorksArray = Array.isArray(existing_works) ? existing_works : typeof existing_works === 'string' ? [existing_works] : [];
            workImageUrls = existingWorksArray.filter(url => url && !url.startsWith('blob:'));
        }

        const existingCard = await BusinessCard.findOne({ user });

        // --- Handle Image Uploads and Removals ---

        // Handle cover photo
        if (req.files?.cover_photo?.[0]) {
            const coverFile = req.files.cover_photo[0];
            const ext = path.extname(coverFile.originalname);
            const key = `cover_photos/${user}/${uuidv4()}${ext}`; // User-specific folder in S3
            coverPhotoUrl = await uploadToS3(coverFile.buffer, key, process.env.AWS_CARD_BUCKET_NAME, process.env.AWS_CARD_BUCKET_REGION, coverFile.mimetype);
        } else if (cover_photo_removed === 'true') {
            coverPhotoUrl = ''; // Explicitly set to empty string if removed
            // Future improvement: Add S3 delete logic here for old image
        } else {
            coverPhotoUrl = existingCard?.cover_photo || null; // Retain existing if not changed or removed
        }

        // Handle avatar
        if (req.files?.avatar?.[0]) {
            const avatarFile = req.files.avatar[0];
            const ext = path.extname(avatarFile.originalname);
            const key = `avatars/${user}/${uuidv4()}${ext}`; // User-specific folder in S3
            avatarUrl = await uploadToS3(avatarFile.buffer, key, process.env.AWS_CARD_BUCKET_NAME, process.env.AWS_CARD_BUCKET_REGION, avatarFile.mimetype);
        } else if (avatar_removed === 'true') {
            avatarUrl = ''; // Explicitly set to empty string if removed
            // Future improvement: Add S3 delete logic here for old image
        } else {
            avatarUrl = existingCard?.avatar || null; // Retain existing if not changed or removed
        }

        // Handle new work images (append to existing ones)
        if (req.files?.work_images && req.files.work_images.length > 0) {
            for (const file of req.files.work_images) {
                const ext = path.extname(file.originalname);
                const key = `work_images/${user}/${uuidv4()}${ext}`; // User-specific folder in S3
                const imageUrl = await uploadToS3(file.buffer, key, process.env.AWS_CARD_BUCKET_NAME, process.env.AWS_CARD_BUCKET_REGION, file.mimetype);
                workImageUrls.push(imageUrl);
            }
        }

        // --- Prepare Data for BusinessCard Model ---
        const updateData = {
            business_card_name,
            page_theme,
            style,
            main_heading,
            sub_heading,
            bio,
            job_title,
            full_name,
            works: workImageUrls,
            services: parsedServices,
            reviews: parsedReviews,
            cover_photo: coverPhotoUrl,
            avatar: avatarUrl,
            contact_email,
            phone_number,
        };

        // Find and Update/Create the BusinessCard for the user
        const updatedCard = await BusinessCard.findOneAndUpdate(
            { user }, // Query by user ID
            updateData,
            { new: true, upsert: true, runValidators: true } // Return new doc, create if not exists, validate
        );

        // Also update the User model for relevant fields if necessary (as MyProfile might fetch from User)
        await User.findByIdAndUpdate(user, {
            name: full_name,
            bio: bio,
            job_title: job_title,
            avatar: avatarUrl,
        }, { new: true });

        res.status(200).json({ message: 'Business card saved successfully', data: updatedCard });
    } catch (err) {
        console.error('Create business card error:', err);
        // Provide more detailed error in development, generic in production
        res.status(500).json({ message: 'Internal server error', error: err.message || 'Unknown error during save.' });
    }
});

// GET /api/business-card/my_card (Protected)
router.get('/my_card', authenticateToken, async (req, res) => {
    // req.user.id is set by the authenticateToken middleware
    const userId = req.user.id;

    if (!userId) {
        // This case should ideally not be hit if authenticateToken works correctly
        return res.status(401).json({ error: 'Unauthorized: User ID not found in token' });
    }

    try {
        // Find the business card by the authenticated user's ID
        const card = await BusinessCard.findOne({ user: userId });
        if (!card) {
            // If no card is found, return a 200 OK with null data or an empty object.
            // This tells the frontend that the request was successful, but no card exists yet.
            return res.status(200).json(null);
        }
        res.status(200).json(card);
    } catch (err) {
        console.error('Error getting card by user ID:', err);
        res.status(500).json({ error: 'Failed to fetch business card' });
    }
});

// GET /api/business-card/by_username/:username (Public - no authentication needed)
router.get('/by_username/:username', async (req, res) => {
    try {
        const { username } = req.params;

        // Find the user by username
        const user = await User.findOne({ username: username.toLowerCase().trim() });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Find the business card associated with that user
        const card = await BusinessCard.findOne({ user: user._id });
        if (!card) {
            return res.status(404).json({ message: 'Business card not found for this user' });
        }

        res.status(200).json(card);
    } catch (err) {
        console.error('Error fetching business card by username:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;