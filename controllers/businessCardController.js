  const BusinessCard = require('../models/BusinessCard');
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
    try {
      const {
        business_card_name,
        page_theme,
        style,
        main_heading,
        sub_heading,
        full_name,
        bio,
        job_title,
        user,
        works,
        services,
      } = req.body;

      if (!user) return res.status(400).json({ error: 'Missing user ID' });

      // Parse arrays safely
      let parsedWorks = [];
      let parsedServices = [];

      try {
        parsedWorks = typeof works === 'string' ? JSON.parse(works) : Array.isArray(works) ? works : [];
      } catch (err) {
        console.warn('Invalid works JSON. Defaulting to []');
      }

      try {
        parsedServices = typeof services === 'string' ? JSON.parse(services) : Array.isArray(services) ? services : [];
      } catch (err) {
        console.warn('Invalid services JSON. Defaulting to []');
      }

      let coverPhotoUrl = null;
      let avatarUrl = null;

      // Upload cover photo if present
      if (req.files?.cover_photo?.[0]) {
        const file = req.files.cover_photo[0];
        const ext = path.extname(file.originalname);
        const key = `cover_photos/${uuidv4()}${ext}`;

        await s3.send(new PutObjectCommand({
          Bucket: process.env.AWS_CARD_BUCKET_NAME,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
        }));

        coverPhotoUrl = `https://${process.env.AWS_CARD_BUCKET_NAME}.s3.${process.env.AWS_CARD_BUCKET_REGION}.amazonaws.com/${key}`;
      }

      // Upload avatar if present
      if (req.files?.avatar?.[0]) {
        const file = req.files.avatar[0];
        const ext = path.extname(file.originalname);
        const key = `avatars/${uuidv4()}${ext}`;

        await s3.send(new PutObjectCommand({
          Bucket: process.env.AWS_CARD_BUCKET_NAME,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
        }));

        avatarUrl = `https://${process.env.AWS_CARD_BUCKET_NAME}.s3.${process.env.AWS_CARD_BUCKET_REGION}.amazonaws.com/${key}`;
      }

      const updateData = {
        business_card_name,
        page_theme,
        style,
        main_heading,
        sub_heading,
        full_name,
        bio,
        job_title,
        works: parsedWorks,
        services: parsedServices,
      };

      if (coverPhotoUrl) updateData.cover_photo = coverPhotoUrl;
      if (avatarUrl) updateData.avatar = avatarUrl;

      const card = await BusinessCard.findOneAndUpdate(
        { user },
        updateData,
        { new: true, upsert: true }
      );

      res.status(200).json({ message: 'Business card saved successfully', data: card });
    } catch (error) {
      console.error('Error saving business card:', error);
      res.status(500).json({ error: 'Failed to save business card' });
    }
  };

  const getBusinessCardByUserId = async (req, res) => {
    try {
      const card = await BusinessCard.findOne({ user: req.params.userId });
      if (!card) return res.status(404).json({ error: 'Business card not found' });
      res.status(200).json({ data: card });
    } catch (err) {
      console.error('Error getting card:', err);
      res.status(500).json({ error: 'Failed to fetch business card' });
    }
  };

  module.exports = {
    createOrUpdateBusinessCard,
    getBusinessCardByUserId,
  };
