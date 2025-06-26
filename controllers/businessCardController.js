const BusinessCard = require('../models/BusinessCard');
const User = require('../models/user');
const { PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
require('dotenv').config();

// S3 Setup - This section is fine as is
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
    // User ID comes from req.user.id set by authenticateToken middleware
    const userId = req.user.id; // Renamed 'user' to 'userId' for clarity

    const {
      business_card_name,
      page_theme,
      style,
      main_heading,
      sub_heading,
      full_name,
      bio,
      job_title,
      services, // Keep this for parsing
      reviews,  // Keep this for parsing
      existing_works, // This is from frontend for existing S3 URLs
      cover_photo_removed,
      avatar_removed,
      contact_email,
      phone_number,
    } = req.body;

    console.log("Backend: Received body data (from req.body):", { userId, business_card_name, full_name, cover_photo_removed, avatar_removed, contact_email, phone_number });
    console.log("Backend: Received files data (from req.files):", req.files); // EXPECTING TO SEE FILES HERE NOW!


    if (!userId) {
      console.error("Backend: Missing user ID in createOrUpdateBusinessCard, authentication failed.");
      return res.status(401).json({ error: 'Unauthorized: User ID not found in token' });
    }

    // Parse arrays safely (these are from req.body)
    let parsedServices = [];
    let parsedReviews = [];
    let parsedWorks = []; // This will be the existing works URLs

    try {
      if (existing_works) {
        parsedWorks = typeof existing_works === 'string' ? JSON.parse(existing_works) : Array.isArray(existing_works) ? existing_works : [];
        // Filter out any blob URLs that might have snuck in if frontend didn't filter
        parsedWorks = parsedWorks.filter(url => url && !url.startsWith('blob:'));
      }
    } catch (err) {
      console.warn('Backend: Invalid existing_works JSON from req.body. Defaulting to []. Error:', err);
    }

    try {
      parsedServices = typeof services === 'string' ? JSON.parse(services) : Array.isArray(services) ? services : [];
    } catch (err) {
      console.warn('Backend: Invalid services JSON. Defaulting to []. Error:', err);
    }

    try {
      parsedReviews = typeof reviews === 'string' ? JSON.parse(reviews) : Array.isArray(reviews) ? reviews : [];
    } catch (err) {
      console.warn('Backend: Invalid reviews JSON. Defaulting to []. Error:', err);
    }


    let coverPhotoUrl = null;
    let avatarUrl = null;

    // Fetch existing card to retain current image URLs if no new upload/removal
    const existingCard = await BusinessCard.findOne({ user: userId }).lean(); // Use .lean() here too
    console.log("Backend: Existing card fetched for user:", existingCard ? { cover_photo: existingCard.cover_photo, avatar: existingCard.avatar, works: existingCard.works?.length } : "None");

    // --- Handle cover photo ---
    if (req.files?.cover_photo?.[0]) {
      console.log("Backend: New cover photo file detected. Processing upload to S3.");
      const file = req.files.cover_photo[0];
      const ext = path.extname(file.originalname);
      const key = `cover_photos/${userId}/${uuidv4()}${ext}`; // User-specific folder in S3
      const uploadToS3Util = require('../utils/uploadToS3'); // Import utility here for local scope
      coverPhotoUrl = await uploadToS3Util(file.buffer, key, process.env.AWS_CARD_BUCKET_NAME, process.env.AWS_CARD_BUCKET_REGION, file.mimetype);
      console.log("Backend: Cover photo uploaded to S3:", coverPhotoUrl);
    } else if (cover_photo_removed === 'true' || cover_photo_removed === true) {
      console.log("Backend: Cover photo explicitly marked for removal. Setting URL to null.");
      coverPhotoUrl = null; // Set to null to remove from DB
      // TODO: Add S3 delete logic here for old image if existingCard.cover_photo
    } else {
      coverPhotoUrl = existingCard?.cover_photo || null; // Retain existing URL from DB if not changed or removed
      console.log("Backend: Retaining existing cover photo URL:", coverPhotoUrl);
    }

    // --- Handle avatar ---
    if (req.files?.avatar?.[0]) {
      console.log("Backend: New avatar file detected. Processing upload to S3.");
      const file = req.files.avatar[0];
      const ext = path.extname(file.originalname);
      const key = `avatars/${userId}/${uuidv4()}${ext}`; // User-specific folder in S3
      const uploadToS3Util = require('../utils/uploadToS3'); // Import utility here for local scope
      avatarUrl = await uploadToS3Util(file.buffer, key, process.env.AWS_CARD_BUCKET_NAME, process.env.AWS_CARD_BUCKET_REGION, file.mimetype);
      console.log("Backend: Avatar uploaded to S3:", avatarUrl);
    } else if (avatar_removed === 'true' || avatar_removed === true) {
      console.log("Backend: Avatar explicitly marked for removal. Setting URL to null.");
      avatarUrl = null; // Set to null to remove from DB
      // TODO: Add S3 delete logic here for old image if existingCard.avatar
    } else {
      avatarUrl = existingCard?.avatar || null; // Retain existing URL from DB if no new file and not removed
      console.log("Backend: Retaining existing avatar URL:", avatarUrl);
    }

    // --- Handle new work images (append to existing ones) ---
    const newWorkImageUrls = [];
    // FIX: Changed req.files?.work_images to req.files?.works
    if (req.files?.works && req.files.works.length > 0) {
      console.log("Backend: New work image files detected. Processing upload to S3.");
      for (const file of req.files.works) { // FIX: Changed req.files.work_images to req.files.works
        const ext = path.extname(file.originalname);
        const key = `work_images/${userId}/${uuidv4()}${ext}`; // User-specific folder in S3
        const uploadToS3Util = require('../utils/uploadToS3'); // Import utility here for local scope
        const imageUrl = await uploadToS3Util(file.buffer, key, process.env.AWS_CARD_BUCKET_NAME, process.env.AWS_CARD_BUCKET_REGION, file.mimetype);
        newWorkImageUrls.push(imageUrl);
      }
      console.log("Backend: New work images uploaded to S3:", newWorkImageUrls);
    }

    // Combine existing works URLs with newly uploaded ones
    const finalWorks = [...(parsedWorks || []), ...newWorkImageUrls];
    console.log("Backend: Final works array before DB update:", finalWorks);

    // --- Prepare Data for BusinessCard Model Update ---
    const updateData = {
      business_card_name,
      page_theme,
      style,
      main_heading,
      sub_heading,
      full_name,
      bio,
      job_title,
      works: finalWorks,
      services: parsedServices,
      reviews: parsedReviews,
      cover_photo: coverPhotoUrl,
      avatar: avatarUrl,
      contact_email,
      phone_number,
    };

    console.log("Backend: Data to be sent to MongoDB (updateData object):", updateData);

    const card = await BusinessCard.findOneAndUpdate(
      { user: userId }, // Query by user ID
      updateData,
      { new: true, upsert: true, runValidators: true }
    ).lean();

    console.log("Backend: MongoDB findOneAndUpdate result (card object):", card);

    if (!card) {
      console.error("Backend: Business card not found or could not be updated after findOneAndUpdate. This should not happen with upsert:true.");
      return res.status(500).json({ error: 'Failed to find or update business card in DB' });
    }

    // Also update the User model for relevant fields (name, bio, job_title, avatar)
    // And importantly, ensure slug/profileUrl/qrCode are set if they were missing or updated
    const currentUser = await User.findById(userId); // Fetch current user to preserve existing fields
    if (!currentUser) {
      console.error("Backend: User not found when trying to update user model after business card save.");
      return res.status(500).json({ error: 'User not found during profile update' });
    }

    const userUpdate = {
      name: full_name,
      bio: bio,
      job_title: job_title,
      avatar: avatarUrl, // Update user's avatar from business card if it changed
      // Ensure qrCode, slug, profileUrl are preserved or updated
      qrCode: currentUser.qrCode, // Preserve existing qrCode
      slug: currentUser.slug,     // Preserve existing slug
      profileUrl: currentUser.profileUrl // Preserve existing profileUrl
    };

    // If slug/profileUrl were missing on user but full_name is now provided, generate them
    if (!currentUser.slug && full_name) {
      const generatedSlug = full_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-*|-*$/g, '');
      userUpdate.slug = generatedSlug;
      userUpdate.profileUrl = `${process.env.CLIENT_URL}/u/${generatedSlug}`;
      console.log("Backend: Generated slug and profileUrl for user:", { slug: generatedSlug, profileUrl: userUpdate.profileUrl });
    }

    await User.findByIdAndUpdate(userId, userUpdate, { new: true });
    console.log("Backend: User model updated with:", userUpdate);

    // Construct the response object including user-specific data from the User model
    // This is crucial for the frontend to get all necessary data in one go
    const userDetails = await User.findById(userId).select('username qrCode profileUrl').lean();

    const responseCard = {
      ...card, // All fields from the business card
      qrCodeUrl: userDetails?.qrCode || '', // Add qrCodeUrl from User model
      username: userDetails?.username || '', // Add username from User model
      publicProfileUrl: userDetails?.profileUrl || '' // Add profileUrl from User model
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

    // FIX: Populate the 'user' field to get qrCode, username, and profileUrl from the User model
    const card = await BusinessCard.findOne({ user: userId })
      .populate({
        path: 'user',
        select: 'qrCode username profileUrl', // Select the fields you need from the User model
      })
      .lean(); // Use .lean() here too

    if (!card) {
      console.log(`Backend: Business card not found for user ID: ${userId}. Returning null data.`);
      return res.status(200).json({ data: null }); // Return 200 OK with null data if no card
    }

    // Construct the response object to include user-specific data from the populated user field
    const responseCard = {
      ...card, // All fields from the business card
      qrCodeUrl: card.user?.qrCode || '', // Add qrCodeUrl from populated User model
      username: card.user?.username || '', // Add username from populated User model
      publicProfileUrl: card.user?.profileUrl || '' // Add profileUrl from populated User model
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