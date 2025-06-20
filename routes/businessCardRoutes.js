const express = require('express');
const router = express.Router();
const multer = require('multer');
const BusinessCard = require('../models/BusinessCard');
const User = require('../models/user');
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

// Multer setup - CORRECTED: Added 'work_images' field
const storage = multer.memoryStorage();
const upload = multer({ storage }).fields([
    { name: 'cover_photo', maxCount: 1 },
    { name: 'avatar', maxCount: 1 },
    { name: 'work_images', maxCount: 10 },
]);

// POST /api/business-card/create_business_card
router.post('/create_business_card', upload, async (req, res) => {
    try {
        const {
            business_card_name,
            page_theme,
            style,
            main_heading,
            sub_heading,
            user,
            bio,
            job_title,
            full_name,
            services,
            reviews,
            existing_works,
            contact_email,
            phone_number,
            // REMOVED: website_url
        } = req.body;

        if (!user) {
            return res.status(400).json({ message: 'Missing required user field' });
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

        if (existing_works) {
            const existingWorksArray = typeof existing_works === 'string' ? [existing_works] : Array.isArray(existing_works) ? existing_works : [];
            workImageUrls = existingWorksArray.filter(url => url && !url.startsWith('blob:'));
        }

        const existingCard = await BusinessCard.findOne({ user });

        if (req.files?.cover_photo?.[0]) {
            const coverFile = req.files.cover_photo[0];
            const ext = path.extname(coverFile.originalname);
            const key = `cover_photos/${uuidv4()}${ext}`;
            await s3.send(new PutObjectCommand({
                Bucket: process.env.AWS_CARD_BUCKET_NAME,
                Key: key,
                Body: coverFile.buffer,
                ContentType: coverFile.mimetype,
            }));
            coverPhotoUrl = `https://${process.env.AWS_CARD_BUCKET_NAME}.s3.${process.env.AWS_CARD_BUCKET_REGION}.amazonaws.com/${key}`;
        }

        if (req.files?.avatar?.[0]) {
            const avatarFile = req.files.avatar[0];
            const ext = path.extname(avatarFile.originalname);
            const key = `avatars/${uuidv4()}${ext}`;
            await s3.send(new PutObjectCommand({
                Bucket: process.env.AWS_CARD_BUCKET_NAME,
                Key: key,
                Body: avatarFile.buffer,
                ContentType: avatarFile.mimetype,
            }));
            avatarUrl = `https://${process.env.AWS_CARD_BUCKET_NAME}.s3.${process.env.AWS_CARD_BUCKET_REGION}.amazonaws.com/${key}`;
        }

        if (req.files?.work_images && req.files.work_images.length > 0) {
            for (const file of req.files.work_images) {
                const ext = path.extname(file.originalname);
                const key = `work_images/${uuidv4()}${ext}`;
                await s3.send(new PutObjectCommand({
                    Bucket: process.env.AWS_CARD_BUCKET_NAME,
                    Key: key,
                    Body: file.buffer,
                    ContentType: file.mimetype,
                }));
                workImageUrls.push(`https://${process.env.AWS_CARD_BUCKET_NAME}.s3.${process.env.AWS_CARD_BUCKET_REGION}.amazonaws.com/${key}`);
            }
        }

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
            cover_photo: coverPhotoUrl !== null ? coverPhotoUrl : (existingCard?.cover_photo || ''),
            avatar: avatarUrl !== null ? avatarUrl : (existingCard?.avatar || ''),
            contact_email,
            phone_number,
            // REMOVED: website_url
        };

        const updatedCard = await BusinessCard.findOneAndUpdate(
            { user },
            updateData,
            { new: true, upsert: true, runValidators: true }
        );

        res.status(200).json({ message: 'Business card saved successfully', data: updatedCard });
    } catch (err) {
        console.error('Create business card error:', err);
        res.status(500).json({ message: 'Internal server error', error: err.message || err.toString() });
    }
});

const getBusinessCardByUserId = async (req, res) => {
    try {
        const card = await BusinessCard.findOne({ user: req.params.userId });
        if (!card) return res.status(404).json({ error: 'Business card not found' });
        res.status(200).json(card);
    } catch (err) {
        console.error('Error getting card:', err);
        res.status(500).json({ error: 'Failed to fetch business card' });
    }
};

const getBusinessCardByUsername = async (req, res) => {
    try {
        const { username } = req.params;

        const user = await User.findOne({ username: username.toLowerCase().trim() });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const card = await BusinessCard.findOne({ user: user._id });
        if (!card) {
            return res.status(404).json({ message: 'Business card not found for this user' });
        }

        res.status(200).json(card);
    } catch (err) {
        console.error('Error fetching business card by username:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
};

router.get('/my_card', getBusinessCardByUserId);
router.get('/by_username/:username', getBusinessCardByUsername);

module.exports = router;