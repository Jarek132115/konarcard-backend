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
const QRCode = require('qrcode');

const createOrUpdateBusinessCard = async (req, res) => {
  try {
    const userId = req.user.id;

    const {
      business_card_name,
      page_theme,
      page_theme_variant,
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
      work_display_mode,
      services_display_mode,
      reviews_display_mode,
      about_me_layout,
      // NEW: Add section visibility flags
      show_main_section,
      show_about_me_section,
      show_work_section,
      show_services_section,
      show_reviews_section,
      show_contact_section
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
      console.error('Backend: Invalid services JSON. Defaulting to []. Error:', err.message);
    }

    try {
      parsedReviews = reviews ? JSON.parse(reviews) : [];
    } catch (err) {
      console.error('Backend: Invalid reviews JSON. Defaulting to []. Error:', err.message);
    }

    let coverPhotoUrl = null;
    let avatarUrl = null;

    const existingCard = await BusinessCard.findOne({ user: userId }).lean();

    if (req.files?.cover_photo?.[0]) {
      const file = req.files.cover_photo[0];
      const ext = path.extname(file.originalname);
      const key = `card_cover_photos/${userId}/${uuidv4()}${ext}`;
      coverPhotoUrl = await uploadToS3Util(file.buffer, key, process.env.AWS_CARD_BUCKET_NAME, process.env.AWS_CARD_BUCKET_REGION, file.mimetype);
    } else if (cover_photo_removed === 'true' || cover_photo_removed === true) {
      coverPhotoUrl = null;
    } else {
      coverPhotoUrl = existingCard?.cover_photo || null;
    }

    if (req.files?.avatar?.[0]) {
      const file = req.files.avatar[0];
      const ext = path.extname(file.originalname);
      const key = `card_avatars/${userId}/${uuidv4()}${ext}`;
      avatarUrl = await uploadToS3Util(file.buffer, key, process.env.AWS_CARD_BUCKET_NAME, process.env.AWS_CARD_BUCKET_REGION, file.mimetype);
    } else if (avatar_removed === 'true' || avatar_removed === true) {
      avatarUrl = null;
    } else {
      avatarUrl = existingCard?.avatar || null;
    }

    const newWorkImageUrls = [];
    if (req.files?.works && req.files.works.length > 0) {
      for (const file of req.files.works) {
        const ext = path.extname(file.originalname);
        const key = `card_work_images/${userId}/${uuidv4()}${ext}`;
        const imageUrl = await uploadToS3Util(file.buffer, key, process.env.AWS_CARD_BUCKET_NAME, process.env.AWS_CARD_BUCKET_REGION, file.mimetype);
        newWorkImageUrls.push(imageUrl);
      }
    }

    const finalWorks = [...parsedWorks, ...newWorkImageUrls];

    const updateBusinessCardData = {
      business_card_name,
      page_theme,
      page_theme_variant,
      style,
      main_heading,
      sub_heading,
      full_name,
      bio,
      job_title,
      works: finalWorks,
      work_display_mode,
      services_display_mode,
      reviews_display_mode,
      about_me_layout,
      // NEW: Ensure visibility flags are set in the update object
      show_main_section: show_main_section === 'true',
      show_about_me_section: show_about_me_section === 'true',
      show_work_section: show_work_section === 'true',
      show_services_section: show_services_section === 'true',
      show_reviews_section: show_reviews_section === 'true',
      show_contact_section: show_contact_section === 'true',
      services: parsedServices,
      reviews: parsedReviews,
      cover_photo: coverPhotoUrl,
      avatar: avatarUrl,
      contact_email,
      phone_number,
    };

    const card = await BusinessCard.findOneAndUpdate(
      { user: userId },
      updateBusinessCardData,
      { new: true, upsert: true, runValidators: true }
    ).lean();

    if (!card) {
      return res.status(500).json({ error: 'Failed to find or update business card in DB' });
    }

    const userDetails = await User.findById(userId).select('username qrCode profileUrl isSubscribed trialExpires').lean();

    const responseCard = {
      ...card,
      qrCodeUrl: userDetails?.qrCode || '',
      username: userDetails?.username || '',
      publicProfileUrl: userDetails?.profileUrl || '',
      isSubscribed: userDetails?.isSubscribed || false,
      trialExpires: userDetails?.trialExpires || null,
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

    // We need to retrieve all fields, not just a subset.
    const card = await BusinessCard.findOne({ user: userId })
      .populate({
        path: 'user',
        select: 'qrCode username profileUrl isSubscribed trialExpires',
      })
      .lean();

    if (!card) {
      return res.status(200).json({ data: null });
    }

    const responseCard = {
      ...card,
      qrCodeUrl: card.user?.qrCode || '',
      username: card.user?.username || '',
      publicProfileUrl: card.user?.profileUrl || '',
      isSubscribed: card.user?.isSubscribed || false,
      trialExpires: card.user?.trialExpires || null,
    };

    res.status(200).json({ data: responseCard });
  } catch (err) {
    console.error('Backend: Error getting card by user ID:', err);
    res.status(500).json({ error: 'Failed to fetch business card', details: err.message });
  }
};

const getBusinessCardByUsername = async (req, res) => {
  const { username } = req.params;

  try {
    const user = await User.findOne({ username }).select('isSubscribed trialExpires').lean();

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // FIX: Retrieve all the data from the BusinessCard model.
    const card = await BusinessCard.findOne({ user: user._id }).lean();

    if (!card) {
      return res.status(404).json({ error: 'Business card not found' });
    }

    const responseData = {
      ...card,
      isSubscribed: user.isSubscribed,
      trialExpires: user.trialExpires,
    };

    res.json(responseData);
  } catch (err) {
    console.error('Backend: Error fetching public business card:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  createOrUpdateBusinessCard,
  getBusinessCardByUserId,
  getBusinessCardByUsername,
};