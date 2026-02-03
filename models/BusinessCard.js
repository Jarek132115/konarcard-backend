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
       GLOBAL profile identity
       Public URL: /u/:profile_slug
    ------------------------------------------------- */
    profile_slug: {
      type: String,
      trim: true,
      lowercase: true,
      required: true,
      match: [/^[a-z0-9-]+$/, "profile_slug can only contain a-z, 0-9 and hyphens"],
    },

    /* -------------------------------------------------
       Ownership (MULTI-PROFILE = many cards per user)
       IMPORTANT: user is NOT unique
    ------------------------------------------------- */
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true, // non-unique (this will create user_1 but NOT unique)
    },

    /* -------------------------------------------------
       Default profile flag (optional but useful)
       Ensures only one default profile per user
    ------------------------------------------------- */
    is_default: {
      type: Boolean,
      default: false,
      index: true,
    },

    /* -------------------------------------------------
       Templates (5 total)
    ------------------------------------------------- */
    template_id: {
      type: String,
      enum: ["template-1", "template-2", "template-3", "template-4", "template-5"],
      default: "template-1",
    },

    /* -------------------------------------------------
       QR for this specific profile
    ------------------------------------------------- */
    qr_code_url: {
      type: String,
      default: "",
    },

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
    page_theme: { type: String, default: "light" },
    page_theme_variant: { type: String, default: "subtle-light" },
    style: { type: String, default: "Inter" },

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
      type: [String],
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
       CTA & text styling
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
       Section visibility
    ------------------------------------------------- */
    show_main_section: { type: Boolean, default: true },
    show_about_me_section: { type: Boolean, default: true },
    show_work_section: { type: Boolean, default: true },
    show_services_section: { type: Boolean, default: true },
    show_reviews_section: { type: Boolean, default: true },
    show_contact_section: { type: Boolean, default: true },

    /* -------------------------------------------------
       Section order
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
  },
  {
    timestamps: true,
    minimize: false,
  }
);

/**
 * ✅ GLOBAL uniqueness:
 * profile_slug must be unique across the entire platform
 */
businessCardSchema.index({ profile_slug: 1 }, { unique: true });

/**
 * ✅ ONE default profile per user (partial unique)
 * Only enforces uniqueness when is_default = true
 */
businessCardSchema.index(
  { user: 1, is_default: 1 },
  { unique: true, partialFilterExpression: { is_default: true } }
);

module.exports = mongoose.model("BusinessCard", businessCardSchema);
