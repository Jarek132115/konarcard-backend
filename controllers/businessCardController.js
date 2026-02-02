// backend/controllers/businessCardController.js
const BusinessCard = require("../models/BusinessCard");
const User = require("../models/user");
const uploadToS3 = require("../utils/uploadToS3");

/**
 * Helpers
 */
const safeSlug = (v) =>
  String(v || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "") || "main";

const parseJsonArray = (v, fallback = []) => {
  try {
    if (v == null) return fallback;
    if (Array.isArray(v)) return v;
    if (typeof v === "string") return JSON.parse(v);
    return fallback;
  } catch {
    return fallback;
  }
};

const asBool = (v, defaultVal = true) => {
  if (v === undefined || v === null || v === "") return defaultVal;
  const s = String(v).toLowerCase();
  if (s === "0" || s === "false") return false;
  if (s === "1" || s === "true") return true;
  return defaultVal;
};

const pickDefaultCard = async (userId) => {
  // 1) is_default
  let card = await BusinessCard.findOne({ user: userId, is_default: true });
  if (card) return card;

  // 2) slug=main
  card = await BusinessCard.findOne({ user: userId, profile_slug: "main" });
  if (card) return card;

  // 3) newest
  card = await BusinessCard.findOne({ user: userId }).sort({ updatedAt: -1 });
  return card || null;
};

/**
 * =========================================================
 * PROTECTED (requireAuth)
 * =========================================================
 */

// GET /api/business-card/me
const getMyBusinessCard = async (req, res) => {
  try {
    if (!req.user?._id) return res.status(401).json({ error: "Unauthorized" });

    const card = await pickDefaultCard(req.user._id);
    return res.json({ data: card });
  } catch (err) {
    console.error("getMyBusinessCard:", err);
    return res.status(500).json({ error: "Failed to fetch business card" });
  }
};

// GET /api/business-card/profiles
const getMyProfiles = async (req, res) => {
  try {
    if (!req.user?._id) return res.status(401).json({ error: "Unauthorized" });

    const cards = await BusinessCard.find({ user: req.user._id }).sort({
      is_default: -1,
      updatedAt: -1,
    });

    return res.json({ data: cards || [] });
  } catch (err) {
    console.error("getMyProfiles:", err);
    return res.status(500).json({ error: "Failed to fetch profiles" });
  }
};

// GET /api/business-card/profiles/:slug
const getMyProfileBySlug = async (req, res) => {
  try {
    if (!req.user?._id) return res.status(401).json({ error: "Unauthorized" });

    const slug = safeSlug(req.params.slug || "main");
    const card = await BusinessCard.findOne({ user: req.user._id, profile_slug: slug });
    return res.json({ data: card || null });
  } catch (err) {
    console.error("getMyProfileBySlug:", err);
    return res.status(500).json({ error: "Failed to fetch profile" });
  }
};

// POST /api/business-card/profiles  (create profile)
const createMyProfile = async (req, res) => {
  try {
    if (!req.user?._id) return res.status(401).json({ error: "Unauthorized" });

    const slug = safeSlug(req.body.profile_slug);
    if (slug.length < 3) return res.status(400).json({ error: "profile_slug must be at least 3 characters" });

    const exists = await BusinessCard.findOne({ user: req.user._id, profile_slug: slug });
    if (exists) return res.status(409).json({ error: "Profile slug already exists" });

    const created = await BusinessCard.create({
      user: req.user._id,
      profile_slug: slug,
      is_default: false,
      template_id: req.body.template_id || "template-1",
      business_card_name: req.body.business_card_name || "",
    });

    return res.status(201).json({ data: created });
  } catch (err) {
    console.error("createMyProfile:", err);
    return res.status(500).json({ error: "Failed to create profile" });
  }
};

// PATCH /api/business-card/profiles/:slug/default
const setDefaultProfile = async (req, res) => {
  try {
    if (!req.user?._id) return res.status(401).json({ error: "Unauthorized" });

    const slug = safeSlug(req.params.slug || "main");

    const card = await BusinessCard.findOne({ user: req.user._id, profile_slug: slug });
    if (!card) return res.status(404).json({ error: "Profile not found" });

    // unset others
    await BusinessCard.updateMany({ user: req.user._id }, { $set: { is_default: false } });
    card.is_default = true;
    await card.save();

    return res.json({ data: card });
  } catch (err) {
    console.error("setDefaultProfile:", err);
    return res.status(500).json({ error: "Failed to set default profile" });
  }
};

// DELETE /api/business-card/profiles/:slug
const deleteMyProfile = async (req, res) => {
  try {
    if (!req.user?._id) return res.status(401).json({ error: "Unauthorized" });

    const slug = safeSlug(req.params.slug || "main");
    const card = await BusinessCard.findOne({ user: req.user._id, profile_slug: slug });
    if (!card) return res.status(404).json({ error: "Profile not found" });

    if (card.is_default) return res.status(400).json({ error: "You can’t delete the default profile" });

    await BusinessCard.deleteOne({ _id: card._id });
    return res.json({ success: true });
  } catch (err) {
    console.error("deleteMyProfile:", err);
    return res.status(500).json({ error: "Failed to delete profile" });
  }
};

// POST /api/business-card  (upsert save, supports profile_slug)
const saveBusinessCard = async (req, res) => {
  try {
    if (!req.user?._id) return res.status(401).json({ error: "Unauthorized" });

    const userId = req.user._id;

    // ✅ IMPORTANT: NEVER trust req.body.user
    const profile_slug = safeSlug(req.body.profile_slug || "main");

    // Arrays from FormData
    const services = parseJsonArray(req.body.services, []);
    const reviews = parseJsonArray(req.body.reviews, []);

    // existing_works comes as repeated fields
    const existing_works = []
      .concat(req.body.existing_works || [])
      .flat()
      .filter(Boolean);

    // Upload cover/avatar if provided
    let cover_photo_url = null;
    let avatar_url = null;

    if (req.files?.cover_photo?.[0]) {
      const f = req.files.cover_photo[0];
      const key = `cover_photos/${userId}/${Date.now()}-${f.originalname}`;
      cover_photo_url = await uploadToS3(f.buffer, key);
    }

    if (req.files?.avatar?.[0]) {
      const f = req.files.avatar[0];
      const key = `avatars/${userId}/${Date.now()}-${f.originalname}`;
      avatar_url = await uploadToS3(f.buffer, key);
    }

    // Upload new work images
    const uploadedWorkUrls = [];
    const workFiles = req.files?.works || [];
    for (const f of workFiles) {
      const key = `works/${userId}/${Date.now()}-${Math.random().toString(16).slice(2)}-${f.originalname}`;
      const url = await uploadToS3(f.buffer, key);
      if (url) uploadedWorkUrls.push(url);
    }

    // Handle removals
    const coverRemoved = asBool(req.body.cover_photo_removed, false);
    const avatarRemoved = asBool(req.body.avatar_removed, false);

    // Build update
    const update = {
      user: userId,
      profile_slug,

      business_card_name: req.body.business_card_name || "",
      page_theme: req.body.page_theme || "light",
      style: req.body.style || "Inter",
      main_heading: req.body.main_heading || "",
      sub_heading: req.body.sub_heading || "",
      full_name: req.body.full_name || "",
      bio: req.body.bio || "",
      job_title: req.body.job_title || "",

      contact_email: req.body.contact_email || "",
      phone_number: req.body.phone_number || "",

      services,
      reviews,

      // these match your UserPage.jsx
      work_display_mode: req.body.work_display_mode || "list",
      services_display_mode: req.body.services_display_mode || "list",
      reviews_display_mode: req.body.reviews_display_mode || "list",
      about_me_layout: req.body.about_me_layout || "side-by-side",

      show_main_section: asBool(req.body.show_main_section, true),
      show_about_me_section: asBool(req.body.show_about_me_section, true),
      show_work_section: asBool(req.body.show_work_section, true),
      show_services_section: asBool(req.body.show_services_section, true),
      show_reviews_section: asBool(req.body.show_reviews_section, true),
      show_contact_section: asBool(req.body.show_contact_section, true),

      button_bg_color: req.body.button_bg_color || "",
      button_text_color: req.body.button_text_color || "",
      text_alignment: req.body.text_alignment || "",

      facebook_url: req.body.facebook_url || "",
      instagram_url: req.body.instagram_url || "",
      linkedin_url: req.body.linkedin_url || "",
      x_url: req.body.x_url || "",
      tiktok_url: req.body.tiktok_url || "",

      section_order: parseJsonArray(req.body.section_order, null),
    };

    if (coverRemoved) update.cover_photo = null;
    if (avatarRemoved) update.avatar = null;

    if (cover_photo_url) update.cover_photo = cover_photo_url;
    if (avatar_url) update.avatar = avatar_url;

    // Works = existing urls + newly uploaded
    update.works = [...existing_works, ...uploadedWorkUrls];

    // Upsert
    const saved = await BusinessCard.findOneAndUpdate(
      { user: userId, profile_slug },
      { $set: update, $setOnInsert: { is_default: profile_slug === "main" } },
      { new: true, upsert: true }
    );

    // Ensure there is always ONE default
    const anyDefault = await BusinessCard.findOne({ user: userId, is_default: true });
    if (!anyDefault) {
      await BusinessCard.updateOne({ _id: saved._id }, { $set: { is_default: true } });
      saved.is_default = true;
    }

    return res.json({ data: saved });
  } catch (err) {
    console.error("saveBusinessCard:", err);
    return res.status(500).json({ error: "Failed to save business card" });
  }
};

/**
 * =========================================================
 * PUBLIC
 * =========================================================
 */

// GET /api/business-card/by_username/:username  (default)
const getPublicByUsername = async (req, res) => {
  try {
    const username = String(req.params.username || "").trim().toLowerCase();
    if (!username) return res.status(400).json({ error: "username required" });

    const u = await User.findOne({ username }).select("_id");
    if (!u) return res.status(404).json({ error: "User not found" });

    const card = await pickDefaultCard(u._id);
    if (!card) return res.status(404).json({ error: "Business card not found" });

    return res.json(card);
  } catch (err) {
    console.error("getPublicByUsername:", err);
    return res.status(500).json({ error: "Failed to fetch business card" });
  }
};

// GET /api/business-card/by_username/:username/:slug
const getPublicByUsernameAndSlug = async (req, res) => {
  try {
    const username = String(req.params.username || "").trim().toLowerCase();
    const slug = safeSlug(req.params.slug);

    if (!username) return res.status(400).json({ error: "username required" });
    if (!slug) return res.status(400).json({ error: "slug required" });

    const u = await User.findOne({ username }).select("_id");
    if (!u) return res.status(404).json({ error: "User not found" });

    const card = await BusinessCard.findOne({ user: u._id, profile_slug: slug });
    if (!card) return res.status(404).json({ error: "Business card not found" });

    return res.json(card);
  } catch (err) {
    console.error("getPublicByUsernameAndSlug:", err);
    return res.status(500).json({ error: "Failed to fetch business card" });
  }
};

module.exports = {
  // protected
  getMyBusinessCard,
  saveBusinessCard,

  getMyProfiles,
  getMyProfileBySlug,
  createMyProfile,
  setDefaultProfile,
  deleteMyProfile,

  // public
  getPublicByUsername,
  getPublicByUsernameAndSlug,
};
