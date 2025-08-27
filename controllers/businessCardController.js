const BusinessCard = require('../models/BusinessCard');
const User = require('../models/user');
const { S3Client } = require('@aws-sdk/client-s3');
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
// const QRCode = require('qrcode'); // kept if used elsewhere

// Helper: coerce possibly-undefined, string, or boolean into boolean with fallback
const toBool = (v, fallback) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  return fallback;
};

// Helper: parse JSON or accept array directly
const parseMaybeJsonArray = (value, fallback = []) => {
  try {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value.trim().length) {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : fallback;
    }
  } catch (e) {
    console.error('Backend: Failed to parse array JSON:', e.message);
  }
  return fallback;
};

const createOrUpdateBusinessCard = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: User ID not found in token' });
    }

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
      // Section visibility (may be omitted, string or boolean)
      show_main_section,
      show_about_me_section,
      show_work_section,
      show_services_section,
      show_reviews_section,
      show_contact_section,
    } = req.body;

    // Load current card to preserve values not being updated
    const existingCard = await BusinessCard.findOne({ user: userId }).lean();

    // Works: keep any existing URLs passed from client + upload new files
    let parsedWorks = [];
    if (existing_works) {
      if (Array.isArray(existing_works)) {
        parsedWorks = existing_works;
      } else if (typeof existing_works === 'string') {
        parsedWorks = [existing_works];
      }
      parsedWorks = parsedWorks.filter((url) => url && !String(url).startsWith('blob:'));
    }

    // Services & reviews: accept array or JSON string
    const parsedServices = parseMaybeJsonArray(services, []);
    const parsedReviews = parseMaybeJsonArray(reviews, []);

    // Handle cover photo
    let coverPhotoUrl = existingCard?.cover_photo || null;
    if (req.files?.cover_photo?.[0]) {
      const file = req.files.cover_photo[0];
      const ext = path.extname(file.originalname);
      const key = `card_cover_photos/${userId}/${uuidv4()}${ext}`;
      coverPhotoUrl = await uploadToS3Util(
        file.buffer,
        key,
        process.env.AWS_CARD_BUCKET_NAME,
        process.env.AWS_CARD_BUCKET_REGION,
        file.mimetype
      );
    } else if (cover_photo_removed === 'true' || cover_photo_removed === true) {
      coverPhotoUrl = null;
    }

    // Handle avatar
    let avatarUrl = existingCard?.avatar || null;
    if (req.files?.avatar?.[0]) {
      const file = req.files.avatar[0];
      const ext = path.extname(file.originalname);
      const key = `card_avatars/${userId}/${uuidv4()}${ext}`;
      avatarUrl = await uploadToS3Util(
        file.buffer,
        key,
        process.env.AWS_CARD_BUCKET_NAME,
        process.env.AWS_CARD_BUCKET_REGION,
        file.mimetype
      );
    } else if (avatar_removed === 'true' || avatar_removed === true) {
      avatarUrl = null;
    }

    // Upload any new work images
    const newWorkImageUrls = [];
    if (req.files?.works && req.files.works.length > 0) {
      for (const file of req.files.works) {
        const ext = path.extname(file.originalname);
        const key = `card_work_images/${userId}/${uuidv4()}${ext}`;
        const imageUrl = await uploadToS3Util(
          file.buffer,
          key,
          process.env.AWS_CARD_BUCKET_NAME,
          process.env.AWS_CARD_BUCKET_REGION,
          file.mimetype
        );
        newWorkImageUrls.push(imageUrl);
      }
    }
    const finalWorks = [...parsedWorks, ...newWorkImageUrls];

    // Build update object with simple fields
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
      services: parsedServices,
      reviews: parsedReviews,
      cover_photo: coverPhotoUrl,
      avatar: avatarUrl,
      contact_email,
      phone_number,
    };

    // Only set visibility flags if provided; otherwise keep existing values (default true)
    if (typeof show_main_section !== 'undefined') {
      updateBusinessCardData.show_main_section = toBool(
        show_main_section,
        existingCard?.show_main_section ?? true
      );
    }
    if (typeof show_about_me_section !== 'undefined') {
      updateBusinessCardData.show_about_me_section = toBool(
        show_about_me_section,
        existingCard?.show_about_me_section ?? true
      );
    }
    if (typeof show_work_section !== 'undefined') {
      updateBusinessCardData.show_work_section = toBool(
        show_work_section,
        existingCard?.show_work_section ?? true
      );
    }
    if (typeof show_services_section !== 'undefined') {
      updateBusinessCardData.show_services_section = toBool(
        show_services_section,
        existingCard?.show_services_section ?? true
      );
    }
    if (typeof show_reviews_section !== 'undefined') {
      updateBusinessCardData.show_reviews_section = toBool(
        show_reviews_section,
        existingCard?.show_reviews_section ?? true
      );
    }
    if (typeof show_contact_section !== 'undefined') {
      updateBusinessCardData.show_contact_section = toBool(
        show_contact_section,
        existingCard?.show_contact_section ?? true
      );
    }

    // Clean out undefined fields so we don't overwrite existing values with undefined
    Object.keys(updateBusinessCardData).forEach((k) => {
      if (typeof updateBusinessCardData[k] === 'undefined') delete updateBusinessCardData[k];
    });

    // Upsert while ensuring new docs get the user field set
    const card = await BusinessCard.findOneAndUpdate(
      { user: userId },
      {
        $set: updateBusinessCardData,
        $setOnInsert: { user: userId },
      },
      { new: true, upsert: true, runValidators: true }
    ).lean();

    if (!card) {
      return res.status(500).json({ error: 'Failed to find or update business card in DB' });
    }

    const userDetails = await User.findById(userId)
      .select('username qrCode profileUrl isSubscribed trialExpires')
      .lean();

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
    console.error('Backend: Error saving business card:', error);
    res
      .status(500)
      .json({ message: 'Internal server error', error: error.message || 'Unknown error during save.' });
  }
};

const getBusinessCardByUserId = async (req, res) => {
  const userId = req.user?.id;

  try {
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: User ID not found in token' });
    }

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
    const user = await User.findOne({ username }).select('isSubscribed trialExpires _id').lean();
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

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

// add this near other imports/exports
const resetBusinessCard = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: User ID not found in token' });
    }

    // If you want to also delete S3 files, you can fetch the doc first and remove them here.
    const deleted = await BusinessCard.findOneAndDelete({ user: userId }).lean();

    // it’s ok if nothing existed — treat as success so UI can go to template
    return res.status(200).json({
      success: true,
      message: 'Business card reset to default.',
      deleted: !!deleted,
    });
  } catch (err) {
    console.error('Backend: Error resetting business card:', err);
    return res.status(500).json({ error: 'Failed to reset business card' });
  }
};


module.exports = {
  createOrUpdateBusinessCard,
  getBusinessCardByUserId,
  getBusinessCardByUsername,
  resetBusinessCard, // add this
};

