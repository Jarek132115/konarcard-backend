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
      existing_works,
      cover_photo_removed,
      avatar_removed,
      contact_email,
      phone_number,
    } = req.body;

    console.log("Backend: Received body data (from req.body):", { userId, business_card_name, full_name, cover_photo_removed, avatar_removed, contact_email, phone_number, existing_works });
    console.log("Backend: Received files data (from req.files):", req.files);

    if (!userId) {
      console.error("Backend: Missing user ID in createOrUpdateBusinessCard, authentication failed.");
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
    console.log("Backend: Parsed existing_works from frontend:", parsedWorks);

    try {
      parsedServices = services ? JSON.parse(services) : [];
    } catch (err) {
      console.warn('Backend: Invalid services JSON. Defaulting to []. Error:', err.message);
    }

    try {
      parsedReviews = reviews ? JSON.parse(reviews) : [];
    } catch (err) {
      console.warn('Backend: Invalid reviews JSON. Defaulting to []. Error:', err.message);
    }

    let coverPhotoUrl = null;
    let avatarUrl = null;

    const existingCard = await BusinessCard.findOne({ user: userId }).lean();
    console.log("Backend: Existing card from DB:", existingCard ? { cover_photo: existingCard.cover_photo, avatar: existingCard.avatar, works: existingCard.works?.length } : "None");

    if (req.files?.cover_photo?.[0]) {
      console.log("Backend: New cover photo file detected.");
      const file = req.files.cover_photo[0];
      const ext = path.extname(file.originalname);
      const key = `card_cover_photos/${userId}/${uuidv4()}${ext}`; // Use specific folder for card images
      coverPhotoUrl = await uploadToS3Util(file.buffer, key, process.env.AWS_CARD_BUCKET_NAME, process.env.AWS_CARD_BUCKET_REGION, file.mimetype);
      console.log("Backend: New cover photo uploaded:", coverPhotoUrl);
    } else if (cover_photo_removed === 'true' || cover_photo_removed === true) {
      console.log("Backend: Cover photo explicitly marked for removal.");
      coverPhotoUrl = null;
    } else {
      coverPhotoUrl = existingCard?.cover_photo || null; // Only keep if it was an existing saved URL
      console.log("Backend: Retaining cover photo. Current URL:", coverPhotoUrl);
    }

    if (req.files?.avatar?.[0]) {
      console.log("Backend: New avatar file detected.");
      const file = req.files.avatar[0];
      const ext = path.extname(file.originalname);
      const key = `card_avatars/${userId}/${uuidv4()}${ext}`; // Use specific folder for card images
      avatarUrl = await uploadToS3Util(file.buffer, key, process.env.AWS_CARD_BUCKET_NAME, process.env.AWS_CARD_BUCKET_REGION, file.mimetype);
      console.log("Backend: New avatar uploaded:", avatarUrl);
    } else if (avatar_removed === 'true' || avatar_removed === true) {
      console.log("Backend: Avatar explicitly marked for removal.");
      avatarUrl = null;
    } else {
      avatarUrl = existingCard?.avatar || null; // Only keep if it was an existing saved URL
      console.log("Backend: Retaining avatar. Current URL:", avatarUrl);
    }


    const newWorkImageUrls = [];
    if (req.files?.works && req.files.works.length > 0) {
      console.log("Backend: New work image files detected.");
      for (const file of req.files.works) {
        const ext = path.extname(file.originalname);
        const key = `card_work_images/${userId}/${uuidv4()}${ext}`; // Use specific folder for card images
        const imageUrl = await uploadToS3Util(file.buffer, key, process.env.AWS_CARD_BUCKET_NAME, process.env.AWS_CARD_BUCKET_REGION, file.mimetype);
        newWorkImageUrls.push(imageUrl);
      }
      console.log("Backend: Newly uploaded work images:", newWorkImageUrls);
    }

    const finalWorks = [...parsedWorks, ...newWorkImageUrls];
    console.log("Backend: Final works array before DB update:", finalWorks);


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

    console.log("Backend: Data to be sent to MongoDB (updateBusinessCardData object):", updateBusinessCardData);

    const card = await BusinessCard.findOneAndUpdate(
      { user: userId },
      updateBusinessCardData, // Use the specific business card data
      { new: true, upsert: true, runValidators: true }
    ).lean();

    console.log("Backend: MongoDB findOneAndUpdate result (card object):", card);

    if (!card) {
      console.error("Backend: Business card not found or could not be updated. This should not happen with upsert:true.");
      return res.status(500).json({ error: 'Failed to find or update business card in DB' });
    }

    // --- CRITICAL FIX START ---
    // Remove the entire block that updates the User model with BusinessCard fields.
    // The User model's name, bio, job_title, and avatar should ONLY be updated
    // via the /update-profile route or registration, NOT from BusinessCard saves.

    // If User.qrCode, User.slug, User.profileUrl are only generated once and tied to username (from registerUser),
    // then this whole block is unnecessary here. If they can be updated based on business card name changes,
    // this logic would need to be very carefully isolated.
    // Based on your User schema, qrCode, slug, profileUrl are on User.
    // Your registerUser sets these based on username. Let's assume they are only set once.
    // If you need the public profile URL to change based on BusinessCard.full_name,
    // then the slug generation logic needs to be in a separate, dedicated endpoint
    // that updates the user and generates a new QR code.
    // For now, removing the problematic overwrite.
    // The current User.qrCode, User.slug, User.profileUrl should be populated from the User object
    // directly in the getBusinessCardByUserId.
    // --- CRITICAL FIX END ---

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
        // Select only the user fields relevant to the BUSINESS CARD's public display
        // and explicitly NOT the user.name (registered name) if it's meant to be separate.
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