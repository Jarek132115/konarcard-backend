const BusinessCard = require('../models/BusinessCard');
const User = require('../models/user');
const { PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
require('dotenv').config();

// S3 Setup
const s3 = new S3Client({
  region: process.env.AWS_CARD_BUCKET_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const uploadToS3Util = require('../utils/uploadToS3');
const QRCode = require('qrcode'); // Ensure this is imported if you're generating QR codes here

const createOrUpdateBusinessCard = async (req, res) => {
  try {
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
      services,
      reviews,
      existing_works,
      cover_photo_removed,
      avatar_removed,
      contact_email,
      phone_number,
    } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: User ID not found in token' });
    }

    let parsedServices = [];
    let parsedReviews = [];
    let parsedWorks = [];

    if (existing_works) {
      if (Array.isArray(existing_works)) {
        parsedWorks = existing_works;
      } else if (typeof existing_works === 'string') {
        parsedWorks = [existing_works];
      }
      parsedWorks = parsedWorks.filter(url => url && !url.startsWith('blob:'));
    }

    try {
      parsedServices = services ? JSON.parse(services) : [];
    } catch (err) {
      console.error('Backend: Invalid services JSON. Defaulting to []. Error:', err.message); // Changed to console.error
    }

    try {
      parsedReviews = reviews ? JSON.parse(reviews) : [];
    } catch (err) {
      console.error('Backend: Invalid reviews JSON. Defaulting to []. Error:', err.message); // Changed to console.error
    }

    let coverPhotoUrl = null;
    let avatarUrl = null;

    const existingCard = await BusinessCard.findOne({ user: userId }).lean();

    if (req.files?.cover_photo?.[0]) {
      const file = req.files.cover_photo[0];
      const ext = path.extname(file.originalname);
      const key = `card_cover_photos/${userId}/${uuidv4()}${ext}`; // Use specific folder for card images
      coverPhotoUrl = await uploadToS3Util(file.buffer, key, process.env.AWS_CARD_BUCKET_NAME, process.env.AWS_CARD_BUCKET_REGION, file.mimetype);
    } else if (cover_photo_removed === 'true' || cover_photo_removed === true) {
      coverPhotoUrl = null;
    } else {
      coverPhotoUrl = existingCard?.cover_photo || null; // Only keep if it was an existing saved URL
    }

    if (req.files?.avatar?.[0]) {
      const file = req.files.avatar[0];
      const ext = path.extname(file.originalname);
      const key = `card_avatars/${userId}/${uuidv4()}${ext}`; // Use specific folder for card images
      avatarUrl = await uploadToS3Util(file.buffer, key, process.env.AWS_CARD_BUCKET_NAME, process.env.AWS_CARD_BUCKET_REGION, file.mimetype);
    } else if (avatar_removed === 'true' || avatar_removed === true) {
      avatarUrl = null;
    } else {
      avatarUrl = existingCard?.avatar || null; // Only keep if it was an existing saved URL
    }

    const newWorkImageUrls = [];
    if (req.files?.works && req.files.works.length > 0) {
      for (const file of req.files.works) {
        const ext = path.extname(file.originalname);
        const key = `card_work_images/${userId}/${uuidv4()}${ext}`; // Use specific folder for card images
        const imageUrl = await uploadToS3Util(file.buffer, key, process.env.AWS_CARD_BUCKET_NAME, process.env.AWS_CARD_BUCKET_REGION, file.mimetype);
        newWorkImageUrls.push(imageUrl);
      }
    }

    const finalWorks = [...parsedWorks, ...newWorkImageUrls];

    // ONLY UPDATE BUSINESS CARD FIELDS HERE
    const updateBusinessCardData = {
      business_card_name,
      page_theme,
      style,
      main_heading,
      sub_heading,
      full_name, // This is the BusinessCard's full_name
      bio, // This is the BusinessCard's bio
      job_title, // This is the BusinessCard's job_title
      works: finalWorks,
      services: parsedServices,
      reviews: parsedReviews,
      cover_photo: coverPhotoUrl,
      avatar: avatarUrl, // This is the BusinessCard's avatar
      contact_email,
      phone_number,
    };

    const card = await BusinessCard.findOneAndUpdate(
      { user: userId },
      updateBusinessCardData, // Use the specific business card data
      { new: true, upsert: true, runValidators: true }
    ).lean();

    if (!card) {
      return res.status(500).json({ error: 'Failed to find or update business card in DB' });
    }

    const userDetails = await User.findById(userId).select('username qrCode profileUrl').lean();

    // Construct responseCard which includes business card data AND relevant user data for client-side
    const responseCard = {
      ...card, // The updated business card fields
      // Directly use the fetched userDetails for username, qrCodeUrl, publicProfileUrl
      qrCodeUrl: userDetails?.qrCode || '',
      username: userDetails?.username || '',
      publicProfileUrl: userDetails?.profileUrl || ''
    };

    res.status(200).json({ message: 'Business card saved successfully', data: responseCard });

  } catch (error) {
    console.error('Backend: Error saving business card in catch block:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message || 'Unknown error during save.' });
  }
};

const getBusinessCardByUserId = async (req, res) => {
  const userId = req.user.id;

  try {
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: User ID not found in token' });
    }

    const card = await BusinessCard.findOne({ user: userId })
      .populate({
        path: 'user',
        // Select only the user fields relevant to the BUSINESS CARD's public display
        // and explicitly NOT the user.name (registered name) if it's meant to be separate.
        select: 'qrCode username profileUrl',
      })
      .lean();

    if (!card) {
      return res.status(200).json({ data: null });
    }

    const responseCard = {
      ...card,
      qrCodeUrl: card.user?.qrCode || '',
      username: card.user?.username || '',
      publicProfileUrl: card.user?.profileUrl || ''
    };

    res.status(200).json({ data: responseCard });
  } catch (err) {
    console.error('Backend: Error getting card by user ID:', err);
    res.status(500).json({ error: 'Failed to fetch business card', details: err.message });
  }
};

module.exports = {
  createOrUpdateBusinessCard,
  getBusinessCardByUserId,
};