const BusinessCard = require('../models/BusinessCard');
const { PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
require('dotenv').config(); // Ensure dotenv is configured for S3 credentials

// S3 Setup - Using environment variables for credentials and region
const s3 = new S3Client({
  region: process.env.AWS_CARD_BUCKET_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Helper function for uploading files to S3 (similar to uploadToS3 utility but for specific use here)
const uploadFileToS3 = async (fileBuffer, folder, userId, mimetype, bucketName, region) => {
  const ext = path.extname(fileBuffer.originalname || ''); // Ensure originalname exists
  const key = `${folder}/${userId}/${uuidv4()}${ext}`; // Path includes user ID for organization

  const params = {
    Bucket: bucketName,
    Key: key,
    Body: fileBuffer.buffer, // Use .buffer for multer memory storage
    ContentType: mimetype,
  };

  await s3.send(new PutObjectCommand(params));
  return `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;
};

// Create or Update Business Card for an Authenticated User
const createOrUpdateBusinessCard = async (req, res) => {
  try {
    // Get user ID from the authenticated token (assumed to be set by authenticateToken middleware)
    const userId = req.user.id;

    const {
      business_card_name,
      page_theme,
      style,
      main_heading,
      sub_heading,
      full_name,
      bio,
      job_title,
      services,       // Comes as JSON string from frontend FormData
      reviews,        // Comes as JSON string from frontend FormData
      existing_works, // Array of URLs for existing work images to retain
      contact_email,
      phone_number,
      cover_photo_removed, // Flag from frontend if photo was explicitly removed
      avatar_removed,      // Flag from frontend if avatar was explicitly removed
    } = req.body;

    // Parse JSON strings for services and reviews safely
    let parsedServices = [];
    let parsedReviews = [];
    try {
      parsedServices = typeof services === 'string' ? JSON.parse(services) : Array.isArray(services) ? services : [];
    } catch (err) {
      console.warn('businessCardController: Invalid services JSON. Defaulting to []. Error:', err);
      // Consider sending a 400 error here if services data is critical and malformed
    }
    try {
      parsedReviews = typeof reviews === 'string' ? JSON.parse(reviews) : Array.isArray(reviews) ? reviews : [];
    } catch (err) {
      console.warn('businessCardController: Invalid reviews JSON. Defaulting to []. Error:', err);
      // Consider sending a 400 error here if reviews data is critical and malformed
    }

    let coverPhotoUrl = null;
    let avatarUrl = null;
    let workImageUrls = [];

    // Retain existing work images that are not "blob:" URLs (temporary client-side previews)
    if (existing_works) {
      const existingWorksArray = typeof existing_works === 'string' ? [existing_works] : Array.isArray(existing_works) ? existing_works : [];
      workImageUrls = existingWorksArray.filter(url => url && !url.startsWith('blob:'));
    }

    // Fetch existing card data to preserve unchanged fields and current image URLs
    const existingCard = await BusinessCard.findOne({ user: userId });

    // Handle cover photo upload or retention
    if (req.files?.cover_photo?.[0]) {
      coverPhotoUrl = await uploadFileToS3(
        req.files.cover_photo[0],
        'cover_photos',
        userId,
        req.files.cover_photo[0].mimetype,
        process.env.AWS_CARD_BUCKET_NAME,
        process.env.AWS_CARD_BUCKET_REGION
      );
    } else if (cover_photo_removed === 'true') {
      coverPhotoUrl = ''; // User explicitly removed it
    } else if (existingCard?.cover_photo) {
      coverPhotoUrl = existingCard.cover_photo; // Retain existing if not replaced or removed
    }

    // Handle avatar upload or retention
    if (req.files?.avatar?.[0]) {
      avatarUrl = await uploadFileToS3(
        req.files.avatar[0],
        'avatars',
        userId,
        req.files.avatar[0].mimetype,
        process.env.AWS_CARD_BUCKET_NAME,
        process.env.AWS_CARD_BUCKET_REGION
      );
    } else if (avatar_removed === 'true') {
      avatarUrl = ''; // User explicitly removed it
    } else if (existingCard?.avatar) {
      avatarUrl = existingCard.avatar; // Retain existing if not replaced or removed
    }

    // Handle new work images upload
    if (req.files?.work_images && req.files.work_images.length > 0) {
      for (const file of req.files.work_images) {
        const imageUrl = await uploadFileToS3(
          file,
          'work_images',
          userId,
          file.mimetype,
          process.env.AWS_CARD_BUCKET_NAME,
          process.env.AWS_CARD_BUCKET_REGION
        );
        workImageUrls.push(imageUrl);
      }
    }
    // At this point, `workImageUrls` contains all URLs (retained existing + newly uploaded)

    const updateData = {
      business_card_name,
      page_theme,
      style,
      main_heading,
      sub_heading,
      full_name,
      bio,
      job_title,
      works: workImageUrls, // Save the combined list of work image URLs
      services: parsedServices,
      reviews: parsedReviews,
      cover_photo: coverPhotoUrl, // This will be null, '', or a URL
      avatar: avatarUrl,         // This will be null, '', or a URL
      contact_email,
      phone_number,
    };

    // Find and update/create the business card for the authenticated user
    const card = await BusinessCard.findOneAndUpdate(
      { user: userId }, // Query by authenticated user ID
      updateData,
      { new: true, upsert: true, runValidators: true } // new: return updated doc; upsert: create if not found
    );

    res.status(200).json({ message: 'Business card saved successfully', data: card });
  } catch (error) {
    console.error('Error saving business card:', error);
    res.status(500).json({ error: 'Failed to save business card', details: error.message || error.toString() });
  }
};

// Get Business Card by User ID (for authenticated user's own card)
const getBusinessCardByUserId = async (req, res) => {
  try {
    // User ID comes from the authenticated token (req.user.id)
    const userId = req.user.id;
    const card = await BusinessCard.findOne({ user: userId });

    // If no card is found, return 200 with null data, indicating no card exists yet for this user
    if (!card) {
      return res.status(200).json({ data: null, message: "No business card found for this user. Please create one." });
    }
    res.status(200).json({ data: card });
  } catch (err) {
    console.error('Error getting card by user ID:', err);
    res.status(500).json({ error: 'Failed to fetch business card.' });
  }
};

// Get Business Card by Username (for public profiles) - This route will NOT be protected by JWT
const getBusinessCardByUsername = async (req, res) => {
  try {
    const { username } = req.params;
    const user = await User.findOne({ username: username.toLowerCase().trim() });

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const card = await BusinessCard.findOne({ user: user._id });
    if (!card) {
      return res.status(404).json({ error: 'Business card not found for this user.' });
    }

    res.status(200).json(card);
  } catch (err) {
    console.error('Error fetching business card by username:', err);
    res.status(500).json({ error: 'Internal server error fetching public profile.' });
  }
};

module.exports = {
  createOrUpdateBusinessCard,
  getBusinessCardByUserId,
  getBusinessCardByUsername, // Export this function so it can be used in businessCardRoutes.js
};