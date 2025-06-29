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

// Helper function to upload to S3 (assuming it exists in utils/uploadToS3.js)
const uploadToS3Util = require('../utils/uploadToS3');

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

    // Handle existing_works: it comes as an array of strings from FormData if multiple, or a single string
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

    // --- FIX: Handle cover photo persistence and defaults ---
    if (req.files?.cover_photo?.[0]) {
      console.log("Backend: New cover photo file detected.");
      const file = req.files.cover_photo[0];
      const ext = path.extname(file.originalname);
      const key = `cover_photos/${userId}/${uuidv4()}${ext}`;
      coverPhotoUrl = await uploadToS3Util(file.buffer, key, process.env.AWS_CARD_BUCKET_NAME, process.env.AWS_CARD_BUCKET_REGION, file.mimetype);
      console.log("Backend: New cover photo uploaded:", coverPhotoUrl);
    } else if (cover_photo_removed === 'true' || cover_photo_removed === true) {
      console.log("Backend: Cover photo explicitly marked for removal.");
      coverPhotoUrl = null; // Set to null if removed
    } else {
      // If no new file and not marked for removal, retain existing OR use the default from frontend if present in req.body.cover_photo
      // The frontend sends the default path in `state.coverPhoto` if no custom image is set.
      coverPhotoUrl = existingCard?.cover_photo || req.body.coverPhoto || null; // Use req.body.coverPhoto for default public paths
      console.log("Backend: Retaining cover photo. Current URL:", coverPhotoUrl);
    }

    // --- FIX: Handle avatar persistence and defaults ---
    if (req.files?.avatar?.[0]) {
      console.log("Backend: New avatar file detected.");
      const file = req.files.avatar[0];
      const ext = path.extname(file.originalname);
      const key = `avatars/${userId}/${uuidv4()}${ext}`;
      avatarUrl = await uploadToS3Util(file.buffer, key, process.env.AWS_CARD_BUCKET_NAME, process.env.AWS_CARD_BUCKET_REGION, file.mimetype);
      console.log("Backend: New avatar uploaded:", avatarUrl);
    } else if (avatar_removed === 'true' || avatar_removed === true) {
      console.log("Backend: Avatar explicitly marked for removal.");
      avatarUrl = null; // Set to null if removed
    } else {
      // If no new file and not marked for removal, retain existing OR use the default from frontend if present in req.body.avatar
      avatarUrl = existingCard?.avatar || req.body.avatar || null; // Use req.body.avatar for default public paths
      console.log("Backend: Retaining avatar. Current URL:", avatarUrl);
    }


    // --- FIX: Handle works (images) persistence and defaults ---
    const newWorkImageUrls = [];
    if (req.files?.works && req.files.works.length > 0) {
      console.log("Backend: New work image files detected.");
      for (const file of req.files.works) {
        const ext = path.extname(file.originalname);
        const key = `work_images/${userId}/${uuidv4()}${ext}`;
        const imageUrl = await uploadToS3Util(file.buffer, key, process.env.AWS_CARD_BUCKET_NAME, process.env.AWS_CARD_BUCKET_REGION, file.mimetype);
        newWorkImageUrls.push(imageUrl);
      }
      console.log("Backend: Newly uploaded work images:", newWorkImageUrls);
    }

    // Determine finalWorks:
    // 1. Start with existing S3 URLs that frontend sent back (parsedWorks)
    // 2. Add any newly uploaded S3 URLs (newWorkImageUrls)
    // 3. If the combined list is empty, but the frontend's original state had default work images (sent via req.body.works if they were not Files)
    // This is tricky. Frontend now filters out defaults for `worksToUpload`.
    // The most robust way is to rebuild `works` on backend considering *all* pieces:
    // - Existing S3 URLs (`parsedWorks`)
    // - Newly uploaded URLs (`newWorkImageUrls`)
    const finalWorks = [...parsedWorks, ...newWorkImageUrls];

    // If the frontend didn't send any 'works' or 'existing_works' AND no new files were uploaded,
    // it means all works were implicitly removed or were just initial defaults that were not replaced.
    // In this case, ensure 'works' in DB becomes empty unless you want to persist defaults here explicitly.
    // For now, `finalWorks` correctly reflects only user-provided (existing or new) images.
    // If the user clears all images (leaving only defaults on frontend), finalWorks will be [].
    // This effectively clears the works array in DB, which is usually desired for 'delete all' action.
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
      { user: userId },
      updateData,
      { new: true, upsert: true, runValidators: true }
    ).lean();

    console.log("Backend: MongoDB findOneAndUpdate result (card object):", card);

    if (!card) {
      console.error("Backend: Business card not found or could not be updated. This should not happen with upsert:true.");
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