// backend/models/BusinessCard.js
const mongoose = require("mongoose");

const serviceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    price: { type: String, default: "" },
  },
  { _id: false }
);

const reviewSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    text: { type: String, required: true, trim: true },
    rating: { type: Number, min: 0, max: 5, default: 5 },
  },
  { _id: false }
);

const businessCardSchema = new mongoose.Schema(
  {
    /* -------------------------------------------------
       Core identity
    ------------------------------------------------- */
    business_card_name: { type: String, default: "" },
    full_name: { type: String, default: "" },
    job_title: { type: String, default: "" },
    bio: { type: String, default: "" },

    /* -------------------------------------------------
       Theme & typography
    ------------------------------------------------- */
    page_theme: { type: String, default: "light" }, // light | dark
    page_theme_variant: { type: String, default: "subtle-light" },
    style: { type: String, default: "Inter" }, // font

    /* -------------------------------------------------
       Headings
    ------------------------------------------------- */
    main_heading: { type: String, default: "" },
    sub_heading: { type: String, default: "" },

    /* -------------------------------------------------
       Media
    ------------------------------------------------- */
    avatar: { type: String, default: "" },
    cover_photo: { type: String, default: "" },

    works: {
      type: [String], // S3 URLs
      default: [],
    },

    work_display_mode: {
      type: String,
      enum: ["list", "grid"],
      default: "list",
    },

    /* -------------------------------------------------
       Services & reviews
    ------------------------------------------------- */
    services: {
      type: [serviceSchema],
      default: [],
    },

    services_display_mode: {
      type: String,
      enum: ["list", "cards"],
      default: "list",
    },

    reviews: {
      type: [reviewSchema],
      default: [],
    },

    reviews_display_mode: {
      type: String,
      enum: ["list", "cards"],
      default: "list",
    },

    about_me_layout: {
      type: String,
      enum: ["side-by-side", "stacked"],
      default: "side-by-side",
    },

    /* -------------------------------------------------
       CTA button & text styling
    ------------------------------------------------- */
    button_bg_color: { type: String, default: "#F47629" },
    button_text_color: {
      type: String,
      enum: ["white", "black"],
      default: "white",
    },
    text_alignment: {
      type: String,
      enum: ["left", "center", "right"],
      default: "left",
    },

    /* -------------------------------------------------
       Section visibility toggles
    ------------------------------------------------- */
    show_main_section: { type: Boolean, default: true },
    show_about_me_section: { type: Boolean, default: true },
    show_work_section: { type: Boolean, default: true },
    show_services_section: { type: Boolean, default: true },
    show_reviews_section: { type: Boolean, default: true },
    show_contact_section: { type: Boolean, default: true },

    /* -------------------------------------------------
       Section order (rendering order)
    ------------------------------------------------- */
    section_order: {
      type: [String],
      default: ["main", "about", "work", "services", "reviews", "contact"],
    },

    /* -------------------------------------------------
       Contact info
    ------------------------------------------------- */
    contact_email: { type: String, default: "" },
    phone_number: { type: String, default: "" },

    /* -------------------------------------------------
       Social links
    ------------------------------------------------- */
    facebook_url: { type: String, default: "" },
    instagram_url: { type: String, default: "" },
    linkedin_url: { type: String, default: "" },
    x_url: { type: String, default: "" },
    tiktok_url: { type: String, default: "" },

    /* -------------------------------------------------
       Ownership (1 profile per user for now)
    ------------------------------------------------- */
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
  },
  {
    timestamps: true,
    minimize: false, // IMPORTANT: keep empty objects/arrays
  }
);

module.exports = mongoose.model("BusinessCard", businessCardSchema);
