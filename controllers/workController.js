const Work = require('../models/Work');
const multer = require('multer');
const path = require('path');
const { PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const { v4: uuidv4 } = require('uuid');
const dotenv = require('dotenv').config();


const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const BUCKET_NAME = process.env.BUCKET_NAME;
const BUCKET_REGION = process.env.BUCKET_REGION;
const ACCESS_KEY = process.env.ACCESS_KEY;
const SECRET_ACCESS_KEY = process.env.SECRET_ACCESS_KEY;

const s3 = new S3Client({
  region: BUCKET_REGION,
  credentials: {
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_ACCESS_KEY,
  },
});


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
    const work_names = Array.isArray(req.body.work_name)
      ? req.body.work_name
      : [req.body.work_name];

    const files = req.files;

    if (!user || !work_names.length || files.length !== work_names.length) {
      return res.status(400).json({ error: 'Mismatch between work_name and work_images or missing data' });
    }

    const uploadPromises = files.map((file, idx) => {
      const ext = path.extname(file.originalname);
      const key = `works/${uuidv4()}${ext}`;

      const params = {
        Bucket: BUCKET_NAME,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      };

      return s3.send(new PutObjectCommand(params)).then(() => ({
        work_name: work_names[idx],
        work_image: `https://${BUCKET_NAME}.s3.${BUCKET_REGION}.amazonaws.com/${key}`,
        user: user,
      }));
    });

    const worksToSave = await Promise.all(uploadPromises);
    const createdWorks = await Work.insertMany(worksToSave);

    res.status(201).json({ message: 'Works created successfully', data: createdWorks });
  } catch (err) {
    console.error(err);
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

// READ ALL SERVICES BY USER ID
exports.getWorkByUserId = async (req, res) => {
  try {
    const services = await Work.find({ user: req.params.userid }).populate('user');
    if (!services || services.length === 0)
      return res.status(404).json({ message: "No Works found for this user" });

    res.json(services);
  } catch (err) {
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
