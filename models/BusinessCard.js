const mongoose = require('mongoose');

const businessCardSchema = new mongoose.Schema({
  business_card_name: { type: String, default: '' },
  page_theme: { type: String, default: 'light' },
  style: { type: String, default: 'Inter' },
  main_heading: { type: String, default: '' },
  sub_heading: { type: String, default: '' },
  bio: { type: String, default: '' },
  job_title: { type: String, default: '' },
  full_name: { type: String, default: '' },
  avatar: { type: String, default: '' },
  cover_photo: { type: String, default: '' },
  works: {
    type: [String], // Array of Strings for S3 URLs
    default: [],
  },
  services: {
    type: [{
      name: { type: String, required: true },
      price: { type: String, required: false },
    }],
    default: [],
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },
  reviews: {
    type: [{
      name: { type: String, required: true },
      text: { type: String, required: true },
      rating: { type: Number, min: 0, max: 5, default: 5 },
    }],
    default: [],
  },
  contact_email: { type: String, default: '' },
  phone_number: { type: String, default: '' },
  // REMOVED: website_url field
}, { timestamps: true });

module.exports = mongoose.model('BusinessCard', businessCardSchema);