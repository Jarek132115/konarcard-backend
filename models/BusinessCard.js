const mongoose = require('mongoose');
const { Schema } = mongoose;

const businessCardSchema = new Schema({
  business_card_name: { type: String, default: '' },
  page_theme: { type: String, default: 'light' },
  page_theme_variant: { type: String, default: 'subtle-light' },
  style: { type: String, default: 'Inter' },
  main_heading: { type: String, default: '' },
  sub_heading: { type: String, default: '' },
  bio: { type: String, default: '' },
  job_title: { type: String, default: '' },
  full_name: { type: String, default: '' },
  avatar: { type: String, default: '' },
  cover_photo: { type: String, default: '' },
  works: {
    type: [String],
    default: [],
  },
  work_display_mode: { type: String, default: 'list' },
  services_display_mode: { type: String, default: 'list' },
  reviews_display_mode: { type: String, default: 'list' },
  about_me_layout: { type: String, default: 'side-by-side' },

  // NEW: Fields to store section visibility
  show_main_section: { type: Boolean, default: true },
  show_about_me_section: { type: Boolean, default: true },
  show_work_section: { type: Boolean, default: true },
  show_services_section: { type: Boolean, default: true },
  show_reviews_section: { type: Boolean, default: true },
  show_contact_section: { type: Boolean, default: true },

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
}, { timestamps: true });

module.exports = mongoose.model('BusinessCard', businessCardSchema);