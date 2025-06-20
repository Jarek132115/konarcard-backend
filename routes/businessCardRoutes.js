const express = require('express');
const router = express.Router();
const multer = require('multer');
const BusinessCard = require('../models/BusinessCard');
const User = require('../models/user'); // User model is needed for by_username route
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
require('dotenv').config();

// AWS S3 Setup
const s3 = new S3Client({
    region: process.env.AWS_CARD_BUCKET_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

// Multer setup - for handling multipart/form-data (files and text fields)
const storage = multer.memoryStorage();
const upload = multer({ storage }).fields([
    { name: 'cover_photo', maxCount: 1 },
    { name: 'avatar', maxCount: 1 },
    { name: 'work_images', maxCount: 10 }, // Allow up to 10 work images
]);

// JWT Authentication Middleware (Crucial for protecting routes)
const jwt = require('jsonwebtoken'); // IMPORTANT: Make sure jwt is imported here
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: No token provided or malformed.' });
    }
    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized: Token missing.' });
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // Attach decoded user data (including user ID) to the request object
        next();
    } catch (err) {
        console.error('JWT verification failed in businessCardRoutes:', err);
        return res.status(403).json({ error: 'Forbidden: Invalid or expired token.' });
    }
};

// POST /api/business-card/create_business_card (or update)
// This route now requires authentication (authenticateToken middleware)
router.post('/create_business_card', authenticateToken, upload, async (req, res) => {
    console.log('businessCardRoutes.js: create_business_card route hit');
    try {
        // User ID comes directly from the authenticated token payload (req.user.id)
        const userId = req.user.id;

        const {
            business_card_name,
            page_theme,
            style,
            main_heading,
            sub_heading,
            bio,
            job_title,
            full_name,
            services,       // Comes as JSON string from frontend FormData
            reviews,        // Comes as JSON string from frontend FormData
            existing_works, // Array of URLs for existing work images to retain
            contact_email,
            phone_number,
            cover_photo_removed, // Flag from frontend if photo was explicitly removed
            avatar_removed,      // Flag from frontend if avatar was explicitly removed
        } = req.body;

        // If frontend accidentally sends a 'user' field in body, log a warning and ensure we use JWT's userId
        if (req.body.user && req.body.user !== userId) {
            console.warn('businessCardRoutes.js: User ID mismatch in request body and JWT. Prioritizing JWT user ID for security.');
        }

        // Parse JSON strings for services and reviews safely
        let parsedServices = [];
        let parsedReviews = [];
        try {
            parsedServices = typeof services === 'string' ? JSON.parse(services) : Array.isArray(services) ? services : [];
        } catch (err) {
            console.warn('businessCardRoutes.js: Invalid services JSON. Defaulting to []. Error:', err);
        }
        try {
            parsedReviews = typeof reviews === 'string' ? JSON.parse(reviews) : Array.isArray(reviews) ? reviews : [];
        } catch (err) {
            console.warn('businessCardRoutes.js: Invalid reviews JSON. Defaulting to []. Error:', err);
        }

        let coverPhotoUrl = null;
        let avatarUrl = null;
        let workImageUrls = [];

        // Collect existing work image URLs that were sent from the frontend to be retained
        if (existing_works) {
            const existingWorksArray = typeof existing_works === 'string' ? [existing_works] : Array.isArray(existing_works) ? existing_works : [];
            workImageUrls = existingWorksArray.filter(url => url && !url.startsWith('blob:')); // Filter out temporary client-side blob URLs
        }

        // Find the existing business card for the authenticated user to retain existing URLs if not updated
        const existingCard = await BusinessCard.findOne({ user: userId });

        // Handle cover photo upload or retention based on form data
        if (req.files?.cover_photo?.[0]) {
            const coverFile = req.files.cover_photo[0];
            const ext = path.extname(coverFile.originalname);
            const key = `cover_photos/${userId}/${uuidv4()}${ext}`; // Use userId in path for organization
            await s3.send(new PutObjectCommand({
                Bucket: process.env.AWS_CARD_BUCKET_NAME,
                Key: key,
                Body: coverFile.buffer,
                ContentType: coverFile.mimetype,
            }));
            coverPhotoUrl = `https://${process.env.AWS_CARD_BUCKET_NAME}.s3.${process.env.AWS_CARD_BUCKET_REGION}.amazonaws.com/${key}`;
        } else if (cover_photo_removed === 'true') {
            coverPhotoUrl = ''; // User explicitly removed it from the form
        } else if (existingCard?.cover_photo) {
            coverPhotoUrl = existingCard.cover_photo; // Retain existing if no new file and not removed
        }

        // Handle avatar upload or retention
        if (req.files?.avatar?.[0]) {
            const avatarFile = req.files.avatar[0];
            const ext = path.extname(avatarFile.originalname);
            const key = `avatars/${userId}/${uuidv4()}${ext}`; // Use userId in path for organization
            await s3.send(new PutObjectCommand({
                Bucket: process.env.AWS_CARD_BUCKET_NAME,
                Key: key,
                Body: avatarFile.buffer,
                ContentType: avatarFile.mimetype,
            }));
            avatarUrl = `https://${process.env.AWS_CARD_BUCKET_NAME}.s3.${process.env.AWS_CARD_BUCKET_REGION}.amazonaws.com/${key}`;
        } else if (avatar_removed === 'true') {
            avatarUrl = ''; // User explicitly removed it
        } else if (existingCard?.avatar) {
            avatarUrl = existingCard.avatar; // Retain existing if no new file and not removed
        }

        // Handle new work images upload and combine with existing ones
        if (req.files?.work_images && req.files.work_images.length > 0) {
            for (const file of req.files.work_images) {
                const ext = path.extname(file.originalname);
                const key = `work_images/${userId}/${uuidv4()}${ext}`; // Use userId in path for organization
                await s3.send(new PutObjectCommand({
                    Bucket: process.env.AWS_CARD_BUCKET_NAME,
                    Key: key,
                    Body: file.buffer,
                    ContentType: file.mimetype,
                }));
                workImageUrls.push(`https://${process.env.AWS_CARD_BUCKET_NAME}.s3.${process.env.AWS_CARD_BUCKET_REGION}.amazonaws.com/${key}`);
            }
        }
        // At this point, `workImageUrls` contains all URLs (retained existing + newly uploaded)

        // Prepare data for update/create operation
        const updateData = {
            business_card_name,
            page_theme,
            style,
            main_heading,
            sub_heading,
            bio,
            job_title,
            full_name,
            works: workImageUrls, // Save the combined list of work image URLs
            services: parsedServices,
            reviews: parsedReviews,
            cover_photo: coverPhotoUrl, // This will be the new URL, existing URL, or empty string
            avatar: avatarUrl,         // This will be the new URL, existing URL, or empty string
            contact_email,
            phone_number,
        };

        // Find and update/create the business card for the authenticated user
        const updatedCard = await BusinessCard.findOneAndUpdate(
            { user: userId }, // Crucially, query by authenticated user ID from JWT
            updateData,
            { new: true, upsert: true, runValidators: true } // new: return updated doc; upsert: create if not found; runValidators: ensure schema validation
        );

        res.status(200).json({ message: 'Business card saved successfully', data: updatedCard });
    } catch (err) {
        console.error('Error saving/updating business card:', err);
        res.status(500).json({ message: 'Internal server error', error: err.message || err.toString() });
    }
});

// GET /api/business-card/my_card (Protected: fetches card for the authenticated user)
router.get('/my_card', authenticateToken, async (req, res) => {
    try {
        // User ID comes directly from the authenticated token
        const userId = req.user.id;
        const card = await BusinessCard.findOne({ user: userId });

        // If no card is found for the authenticated user, return success with null data
        // This tells the frontend that no card exists and it can prompt the user to create one.
        if (!card) {
            return res.status(200).json({ data: null, message: "No business card found for this user. Please create one." });
        }
        res.status(200).json({ data: card }); // Return the card data wrapped in a 'data' object
    } catch (err) {
        console.error('Error getting card by authenticated user ID:', err);
        res.status(500).json({ error: 'Failed to fetch business card.' });
    }
});

// GET /api/business-card/by_username/:username (Public: fetches card for a public user profile)
router.get('/by_username/:username', async (req, res) => {
    try {
        const { username } = req.params;

        // Find the user by username (case-insensitive and trimmed)
        const user = await User.findOne({ username: username.toLowerCase().trim() });
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // Find the business card associated with that user ID
        const card = await BusinessCard.findOne({ user: user._id });
        if (!card) {
            return res.status(404).json({ message: 'Business card not found for this user.' });
        }

        res.status(200).json(card); // Return the card data directly for public display
    } catch (err) {
        console.error('Error fetching business card by username:', err);
        res.status(500).json({ message: 'Internal server error fetching public profile.' });
    }
});

module.exports = router;