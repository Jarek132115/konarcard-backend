const Work = require('../models/Work');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
// REMOVED: const dotenv = require('dotenv').config(); // Should be handled in index.js
// REMOVED: const { PutObjectCommand, S3Client } = require("@aws-sdk/client-s3"); // Centralized in utils/uploadToS3
// REMOVED: const BUCKET_NAME = process.env.BUCKET_NAME; // Centralized
// REMOVED: const BUCKET_REGION = process.env.BUCKET_REGION; // Centralized
// REMOVED: const ACCESS_KEY = process.env.ACCESS_KEY; // Centralized
// REMOVED: const SECRET_ACCESS_KEY = process.env.SECRET_ACCESS_KEY; // Centralized
// REMOVED: const s3 = new S3Client(...); // Centralized in utils/uploadToS3

const uploadToS3 = require('../utils/uploadToS3'); // Import the centralized S3 upload utility

const storage = multer.memoryStorage();
const uploadMiddleware = multer({ storage: storage }); // Renamed 'upload' to 'uploadMiddleware' to avoid confusion

exports.createWork = async (req, res) => {
  try {
    const work = await Work.create(req.body);
    res.status(201).json(work);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};


exports.createMultipleWorksWithImages = async (req, res) => {
  try {
    const { user } = req.body;
    // ensure work_name is an array
    const work_names = Array.isArray(req.body.work_name)
      ? req.body.work_name
      : [req.body.work_name];

    const files = req.files; // Multer should put files here

    if (!user || !work_names.length || files.length !== work_names.length) {
      return res.status(400).json({ error: 'Mismatch between work_name and work_images or missing data' });
    }

    const uploadPromises = files.map(async (file, idx) => {
      const ext = path.extname(file.originalname);
      const key = `works/${user}/${uuidv4()}${ext}`; // Suggest adding user ID to key for organization

      // Use the CENTRALIZED uploadToS3 utility
      const imageUrl = await uploadToS3(
        file.buffer,
        key,
        process.env.AWS_CARD_BUCKET_NAME, // Use specific bucket name for card images
        process.env.AWS_CARD_BUCKET_REGION, // Use specific region for card images
        file.mimetype // Pass content type
      );

      return {
        work_name: work_names[idx],
        work_image: imageUrl,
        user: user,
      };
    });

    const worksToSave = await Promise.all(uploadPromises);
    const createdWorks = await Work.insertMany(worksToSave);

    res.status(201).json({ message: 'Works created successfully', data: createdWorks });
  } catch (err) {
    console.error('Error in createMultipleWorksWithImages:', err); // Specific log
    res.status(500).json({ error: 'Failed to upload works' });
  }
};


exports.getAllWorks = async (req, res) => {
  try {
    const works = await Work.find().populate('user');
    res.json(works);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getWorkById = async (req, res) => {
  try {
    const work = await Work.findById(req.params.id).populate('user');
    if (!work) return res.status(404).json({ message: 'Work not found' });
    res.json(work);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// READ ALL WORKS BY USER ID (renamed from getServiceByUserId for clarity)
exports.getWorkByUserId = async (req, res) => {
  try {
    const works = await Work.find({ user: req.params.userid }).populate('user'); // Changed from services to works
    if (!works || works.length === 0)
      return res.status(404).json({ message: "No Works found for this user" });

    res.json(works);
  } catch (err) {
    console.error('Error in getWorkByUserId:', err); // Specific log
    res.status(500).json({ error: err.message });
  }
};

exports.updateWork = async (req, res) => {
  try {
    const work = await Work.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!work) return res.status(404).json({ message: 'Work not found' });
    res.json(work);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.deleteWork = async (req, res) => {
  try {
    const work = await Work.findByIdAndDelete(req.params.id);
    if (!work) return res.status(404).json({ message: 'Work not found' });
    res.json({ message: 'Work deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  createWork,
  createMultipleWorksWithImages,
  getAllWorks,
  getWorkById,
  getWorkByUserId,
  updateWork,
  deleteWork,
};