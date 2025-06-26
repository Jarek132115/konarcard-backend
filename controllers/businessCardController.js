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

const createOrUpdateBusinessCard = async (req, res) => {
  console.log("Backend: createOrUpdateBusinessCard function triggered.");
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
      existing_works, // Now expecting this to be an array of strings (or a single string)
      cover_photo_removed,
      avatar_removed,
      contact_email,
      phone_number,
    } = req.body;

    console.log("Backend: Received body data (from req.body):", { userId, business_card_name, full_name, cover_photo_removed, avatar_removed, contact_email, phone_number });
    console.log("Backend: Received files data (from req.files):", req.files);


    if (!userId) {
      console.error("Backend: Missing user ID in createOrUpdateBusinessCard, authentication failed.");
      return res.status(401).json({ error: 'Unauthorized: User ID not found in token' });
    }

    // --- Corrected Parsing for Arrays (services, reviews, and especially existing_works) ---
    let parsedServices = [];
    let parsedReviews = [];
    let parsedWorks = []; // Initialize as empty array

    // Handle existing_works: it comes as an array of strings from FormData if multiple, or a single string
    if (existing_works) {
      if (Array.isArray(existing_works)) {
        parsedWorks = existing_works;
      } else if (typeof existing_works === 'string') {
        // If only one existing_works, it comes as a string, parse it into an array
        parsedWorks = [existing_works];
      }
      // Filter out any blob URLs that might have snuck in (though frontend should ideally prevent this)
      parsedWorks = parsedWorks.filter(url => url && !url.startsWith('blob:'));
    }
    console.log("Backend: Parsed existing_works:", parsedWorks);


    // Safely parse services and reviews (they are stringified JSON from frontend)
    try {
      parsedServices = services ? JSON.parse(services) : [];
    } catch (err) {
      console.warn('Backend: Invalid services JSON. Defaulting to []. Error:', err);
    }

    try {
      parsedReviews = reviews ? JSON.parse(reviews) : [];
    } catch (err) {
      console.warn('Backend: Invalid reviews JSON. Defaulting to []. Error:', err);
    }
    // --- END Corrected Parsing ---


    let coverPhotoUrl = null;
    let avatarUrl = null;

    const existingCard = await BusinessCard.findOne({ user: userId }).lean();
    console.log("Backend: Existing card fetched for user:", existingCard ? { cover_photo: existingCard.cover_photo, avatar: existingCard.avatar, works: existingCard.works?.length } : "None");

    // Handle cover photo
    if (req.files?.cover_photo?.[0]) {
      console.log("Backend: New cover photo file detected. Processing upload to S3.");
      const file = req.files.cover_photo[0];
      const ext = path.extname(file.originalname);
      const key = `cover_photos/${userId}/${uuidv4()}${ext}`;
      const uploadToS3Util = require('../utils/uploadToS3');
      coverPhotoUrl = await uploadToS3Util(file.buffer, key, process.env.AWS_CARD_BUCKET_NAME, process.env.AWS_CARD_BUCKET_REGION, file.mimetype);
      console.log("Backend: Cover photo uploaded to S3:", coverPhotoUrl);
    } else if (cover_photo_removed === 'true' || cover_photo_removed === true) {
      console.log("Backend: Cover photo explicitly marked for removal. Setting URL to null.");
      coverPhotoUrl = null;
    } else {
      coverPhotoUrl = existingCard?.cover_photo || null;
      console.log("Backend: Retaining existing cover photo URL:", coverPhotoUrl);
    }

    // Handle avatar
    if (req.files?.avatar?.[0]) {
      console.log("Backend: New avatar file detected. Processing upload to S3.");
      const file = req.files.avatar[0];
      const ext = path.extname(file.originalname);
      const key = `avatars/${userId}/${uuidv4()}${ext}`;
      const uploadToS3Util = require('../utils/uploadToS3');
      avatarUrl = await uploadToS3Util(file.buffer, key, process.env.AWS_CARD_BUCKET_NAME, process.env.AWS_CARD_BUCKET_REGION, file.mimetype);
      console.log("Backend: Avatar uploaded to S3:", avatarUrl);
    } else if (avatar_removed === 'true' || avatar_removed === true) {
      console.log("Backend: Avatar explicitly marked for removal. Setting URL to null.");
      avatarUrl = null;
    } else {
      avatarUrl = existingCard?.avatar || null;
      console.log("Backend: Retaining existing avatar URL:", avatarUrl);
    }

    // Handle new work images (append to existing ones)
    const newWorkImageUrls = [];
    if (req.files?.works && req.files.works.length > 0) {
      console.log("Backend: New work image files detected. Processing upload to S3.");
      for (const file of req.files.works) {
        const ext = path.extname(file.originalname);
        const key = `work_images/${userId}/${uuidv4()}${ext}`;
        const uploadToS3Util = require('../utils/uploadToS3');
        const imageUrl = await uploadToS3Util(file.buffer, key, process.env.AWS_CARD_BUCKET_NAME, process.env.AWS_CARD_BUCKET_REGION, file.mimetype);
        newWorkImageUrls.push(imageUrl);
      }
      console.log("Backend: New work images uploaded to S3:", newWorkImageUrls);
    }

    // Combine existing works URLs with newly uploaded ones
    const finalWorks = [...(parsedWorks || []), ...newWorkImageUrls];
    console.log("Backend: Final works array before DB update:", finalWorks);

    // Prepare Data for BusinessCard Model Update
    const updateData = {
      business_card_name,
      page_theme,
      style,
      main_heading,
      sub_heading,
      full_name,
      bio,
      job_title,
      works: finalWorks, // This will now contain both old and new work image URLs
      services: parsedServices,
      reviews: parsedReviews,
      cover_photo: coverPhotoUrl,
      avatar: avatarUrl,
      contact_email,
      phone_number,
    };

    console.log("Backend: Data to be sent to MongoDB (updateData object):", updateData);

    const card = await BusinessCard.findOneAndUpdate(
      { user: userId },
      updateData,
      { new: true, upsert: true, runValidators: true }
    ).lean();

    console.log("Backend: MongoDB findOneAndUpdate result (card object):", card);

    if (!card) {
      console.error("Backend: Business card not found or could not be updated after findOneAndUpdate. This should not happen with upsert:true.");
      return res.status(500).json({ error: 'Failed to find or update business card in DB' });
    }

    // Also update the User model for relevant fields (name, bio, job_title, avatar)
    const currentUser = await User.findById(userId);
    if (!currentUser) {
      console.error("Backend: User not found when trying to update user model after business card save.");
      return res.status(500).json({ error: 'User not found during profile update' });
    }

    const userUpdate = {
      name: full_name,
      bio: bio,
      job_title: job_title,
      avatar: avatarUrl,
      qrCode: currentUser.qrCode,
      slug: currentUser.slug,
      profileUrl: currentUser.profileUrl
    };

    if (!currentUser.slug && full_name) {
      const generatedSlug = full_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-*|-*$/g, '');
      userUpdate.slug = generatedSlug;
      userUpdate.profileUrl = `${process.env.CLIENT_URL}/u/${generatedSlug}`;
      console.log("Backend: Generated slug and profileUrl for user:", { slug: generatedSlug, profileUrl: userUpdate.profileUrl });
    }

    await User.findByIdAndUpdate(userId, userUpdate, { new: true });
    console.log("Backend: User model updated with:", userUpdate);

    const userDetails = await User.findById(userId).select('username qrCode profileUrl').lean();

    const responseCard = {
      ...card,
      qrCodeUrl: userDetails?.qrCode || '',
      username: userDetails?.username || '',
      publicProfileUrl: userDetails?.profileUrl || ''
    };

    res.status(200).json({ message: 'Business card saved successfully', data: responseCard });
    console.log("Backend: Sending 200 OK response with updated card and user data.");

  } catch (error) {
    console.error('Backend: Error saving business card in catch block:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message || 'Unknown error during save.' });
  }
};

const getBusinessCardByUserId = async (req, res) => {
  const userId = req.user.id;

  console.log(`Backend: getBusinessCardByUserId triggered for user: ${userId}`);
  try {
    if (!userId) {
      console.log("Backend: getBusinessCardByUserId: User ID is undefined. Cannot fetch card.");
      return res.status(401).json({ error: 'Unauthorized: User ID not found in token' });
    }

    const card = await BusinessCard.findOne({ user: userId })
      .populate({
        path: 'user',
        select: 'qrCode username profileUrl',
      })
      .lean();

    if (!card) {
      console.log(`Backend: Business card not found for user ID: ${userId}. Returning null data.`);
      return res.status(200).json({ data: null });
    }

    const responseCard = {
      ...card,
      qrCodeUrl: card.user?.qrCode || '',
      username: card.user?.username || '',
      publicProfileUrl: card.user?.profileUrl || ''
    };

    console.log("Backend: Fetched business card with populated user data:", responseCard);
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