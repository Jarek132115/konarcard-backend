const mongoose = require('mongoose');
const { Schema } = mongoose;

const businessCardSchema = new Schema({
  business_card_name: { type: String, default: '' },

  // Theme & typography
  page_theme: { type: String, default: 'light' }, // 'light' | 'dark'
  page_theme_variant: { type: String, default: 'subtle-light' },
  style: { type: String, default: 'Inter' }, // font family

  // Headings & bio
  main_heading: { type: String, default: '' },
  sub_heading: { type: String, default: '' },
  bio: { type: String, default: '' },
  job_title: { type: String, default: '' },
  full_name: { type: String, default: '' },

  // Media
  avatar: { type: String, default: '' },
  cover_photo: { type: String, default: '' },
  works: {
    type: [String],
    default: [],
  },

  // Display modes & layout
  work_display_mode: { type: String, default: 'list' },      // 'list' | 'grid' | 'carousel'
  services_display_mode: { type: String, default: 'list' },  // 'list' | 'carousel'
  reviews_display_mode: { type: String, default: 'list' },   // 'list' | 'carousel'
  about_me_layout: { type: String, default: 'side-by-side' },

  // NEW: styling controls
  button_bg_color: { type: String, default: '#F47629' },
  button_text_color: { type: String, default: 'white' }, // 'white' | 'black'
  text_alignment: { type: String, default: 'left' },     // 'left' | 'center' | 'right'

  // NEW: Social links
  facebook_url: { type: String, default: '' },
  instagram_url: { type: String, default: '' },
  linkedin_url: { type: String, default: '' },
  x_url: { type: String, default: '' },
  tiktok_url: { type: String, default: '' },

  // NEW: Section order (render sequence)
  section_order: {
    type: [String],
    default: ['main', 'about', 'work', 'services', 'reviews', 'contact'],
  },

  // Section visibility flags
  show_main_section: { type: Boolean, default: true },
  show_about_me_section: { type: Boolean, default: true },
  show_work_section: { type: Boolean, default: true },
  show_services_section: { type: Boolean, default: true },
  show_reviews_section: { type: Boolean, default: true },
  show_contact_section: { type: Boolean, default: true },

  // Services & reviews
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

  // Contact
  contact_email: { type: String, default: '' },
  phone_number: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('BusinessCard', businessCardSchema);
