const { hashPassword, comparePassword } = require('../helpers/auth');
const User = require('../models/user');
const jwt = require('jsonwebtoken');


const multer = require('multer');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// import { S3Client } from "@aws-sdk/client-s3";
const { S3Client } = require("@aws-sdk/client-s3");


const dotenv = require('dotenv').config();

BUCKET_NAME = process.env.BUCKET_NAME
ACCESS_KEY = process.env.ACCESS_KEY
SECRET_ACCESS_KEY = process.env.SECRET_ACCESS_KEY
BUCKET_REGION = process.env.BUCKET_REGION

const s3 = new S3Client({
  region: process.env.BUCKET_REGION,
  credentials: {
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_ACCESS_KEY,
  },
});


const storage = multer.memoryStorage();
const upload = multer({ storage: storage });


// Test route
const test = (req, res) => {
  res.json('test is working');
};

// Register
const registerUser = async (req, res) => {
  try {
    const { name, email, password, confirmPassword } = req.body;

    if (!name) return res.json({ error: 'Name is required' });
    if (!email) return res.json({ error: 'Email is required' });
    if (!password || password.length < 8)
      return res.json({ error: 'Password must be at least 8 characters' });
    if (password !== confirmPassword)
      return res.json({ error: 'Passwords do not match' });

    const exist = await User.findOne({ email });
    if (exist) return res.json({ error: 'Email is already taken' });

    const hashedPassword = await hashPassword(password);
    const user = await User.create({
      name,
      email,
      password: hashedPassword,
    });

    res.json(user);
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: 'Registration failed. Try again.' });
  }
};



const uploadAvatar = async (req, res) => {
  try {
    const file = req.file;
    const userId = req.params.id;
    console.log("userId: ",userId);
    console.log("file: ",file);
    if (!file) return res.status(400).json({ error: 'No image file uploaded' });

    const ext = path.extname(file.originalname);
    const key = `avatars/${uuidv4()}${ext}`;

    const params = {
      Bucket: BUCKET_NAME,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    };

    await s3.send(new PutObjectCommand(params));

    const avatarUrl = `https://${BUCKET_NAME}.s3.${BUCKET_REGION}.amazonaws.com/${key}`;

    const user = await User.findByIdAndUpdate(userId, { avatar: avatarUrl }, { new: true });

    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({ message: 'Avatar updated successfully', avatar: avatarUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload avatar' });
  }
};


// Login
const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user) return res.json({ error: 'No user found' });
    const match = await comparePassword(password, user.password);

    if (match) {
      jwt.sign({ email: user.email, id: user._id, name: user.name }, process.env.JWT_SECRET, {}, (err, token) => {
        if (err) throw err;
        res.cookie('token', token).json(user);
      });
    } else {
      res.json({ error: 'Passwords do not match' });
    }
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: 'Login failed' });
  }
};

// Get profile
const getProfile = (req, res) => {
  const { token } = req.cookies;
  if (token) {
    jwt.verify(token, process.env.JWT_SECRET, {}, (err, user) => {
      if (err) return res.status(401).json({ error: 'Token invalid' });
      res.json(user);
    });
  } else {
    res.json(null);
  }
};

// Logout
const logoutUser = (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Logged out successfully' });
};

// CRUD operations
const getAllUsers = async (req, res) => {
  try {
    const users = await User.find();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const updateUser = async (req, res) => {
  try {
    const user_id = req.params.id;
    const user = await User.findByIdAndUpdate(user_id, req.body, { new: true });
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const deleteUser = async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ message: "User deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  test,
  registerUser,
  loginUser,
  getProfile,
  logoutUser,
  getAllUsers,
  getUserById,
  updateUser,
  deleteUser,
  uploadAvatar
};
