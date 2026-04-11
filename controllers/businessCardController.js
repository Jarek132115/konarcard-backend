// backend/controllers/businessCardController.js
const BusinessCard = require("../models/BusinessCard");
const User = require("../models/user");
const uploadToS3 = require("../utils/uploadToS3");
const QRCode = require("qrcode");

/**
 * ---------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------
 */

// profile_slug allows ONLY a-z 0-9 and hyphens
const safeSlug = (v) =>
  String(v || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "") || "";

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

const norm = (v) => String(v || "").trim();

const cleanStringArray = (arr) =>
  (Array.isArray(arr) ? arr : [])
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .filter((u) => !u.startsWith("blob:"));

const normalizeServices = (raw) =>
  parseJsonArray(raw, [])
    .map((item) => ({
      name: norm(item?.name),
      description: norm(item?.description || item?.price),
      // legacy compatibility
      price: norm(item?.price || item?.description),
    }))
    .filter((item) => item.name || item.description);

const normalizeReviews = (raw) =>
  parseJsonArray(raw, [])
    .map((item) => ({
      name: norm(item?.name),
      text: norm(item?.text),
      rating: Math.min(5, Math.max(0, Number(item?.rating) || 0)),
    }))
    .filter((item) => item.name || item.text || item.rating > 0);

const getPlan = (userDoc) => {
  const plan = String(userDoc?.plan || "free").toLowerCase();
  if (plan === "plus" || plan === "teams") return plan;
  return "free";
};

const FREE_MAX_WORKS = 6;
const FREE_MAX_SERVICES = 3;
const FREE_MAX_REVIEWS = 3;

const PAID_MAX_WORKS = 12;
const PAID_MAX_SERVICES = 12;
const PAID_MAX_REVIEWS = 12;

const getContentLimitsForPlan = (plan) => {
  if (plan === "plus" || plan === "teams") {
    return {
      maxWorks: PAID_MAX_WORKS,
      maxServices: PAID_MAX_SERVICES,
      maxReviews: PAID_MAX_REVIEWS,
    };
  }

  return {
    maxWorks: FREE_MAX_WORKS,
    maxServices: FREE_MAX_SERVICES,
    maxReviews: FREE_MAX_REVIEWS,
  };
};

const upgradeRequired = (res, payload = {}) => {
  return res.status(403).json({
    code: "UPGRADE_REQUIRED",
    ...payload,
  });
};

const clampPlanContent = ({ plan, works, services, reviews }) => {
  const limits = getContentLimitsForPlan(plan);

  const safeArr = (a) => (Array.isArray(a) ? a : []).filter(Boolean);

  return {
    works: safeArr(works).slice(0, limits.maxWorks),
    services: safeArr(services).slice(0, limits.maxServices),
    reviews: safeArr(reviews).slice(0, limits.maxReviews),
    limits,
  };
};

const normalizeTemplateForPlan = (plan, requestedTemplate) => {
  const allowed = new Set([
    "template-1",
    "template-2",
    "template-3",
    "template-4",
    "template-5",
  ]);

  const t = String(requestedTemplate || "template-1");
  if (!allowed.has(t)) return "template-1";
  if (plan === "free") return "template-1";
  return t;
};

const getMaxProfilesForUser = (userDoc) => {
  const plan = getPlan(userDoc);

  if (plan !== "teams") return 1;

  const teamsQty = Number(userDoc?.teamsProfilesQty);
  if (Number.isFinite(teamsQty) && teamsQty > 0) return Math.max(1, teamsQty);

  const extra = Number(userDoc?.extraProfilesQty);
  const extraSafe = Number.isFinite(extra) ? Math.max(0, extra) : 0;
  return 1 + extraSafe;
};

const hasMeaningfulProfileContent = (cardLike = {}) => {
  const textFields = [
    cardLike.business_name,
    cardLike.business_card_name,
    cardLike.main_heading,
    cardLike.trade_title,
    cardLike.sub_heading,
    cardLike.location,
    cardLike.full_name,
    cardLike.job_title,
    cardLike.bio,
    cardLike.contact_email,
    cardLike.phone_number,
    cardLike.facebook_url,
    cardLike.instagram_url,
    cardLike.linkedin_url,
    cardLike.x_url,
    cardLike.tiktok_url,
  ];

  const hasText = textFields.some((v) => norm(v).length > 0);

  const hasImages = [cardLike.cover_photo, cardLike.logo, cardLike.avatar].some(
    (v) => norm(v).length > 0
  );

  const hasWorks =
    Array.isArray(cardLike.works) && cardLike.works.some((v) => norm(v).length > 0);

  const hasServices =
    Array.isArray(cardLike.services) &&
    cardLike.services.some(
      (s) => norm(s?.name) || norm(s?.description) || norm(s?.price)
    );

  const hasReviews =
    Array.isArray(cardLike.reviews) &&
    cardLike.reviews.some(
      (r) => norm(r?.name) || norm(r?.text) || Number(r?.rating) > 0
    );

  return hasText || hasImages || hasWorks || hasServices || hasReviews;
};

/**
 * ---------------------------------------------------------
 * QR helpers
 * Public URL is ALWAYS: /u/:profile_slug
 * ---------------------------------------------------------
 */

const FRONTEND_PROFILE_DOMAIN =
  process.env.PUBLIC_PROFILE_DOMAIN || "https://www.konarcard.com";

const buildPublicProfileUrl = (profileSlug) => {
  const s = safeSlug(profileSlug);
  if (!s) return "";
  return `${FRONTEND_PROFILE_DOMAIN}/u/${s}`;
};

const generateAndUploadProfileQr = async (userId, profileSlug) => {
  const url = buildPublicProfileUrl(profileSlug);
  if (!url) return "";

  const qrBuffer = await QRCode.toBuffer(url, {
    width: 900,
    margin: 2,
    errorCorrectionLevel: "M",
    color: { dark: "#000000", light: "#ffffff" },
  });

  const safe = safeSlug(profileSlug) || "profile";
  const fileKey = `qr-codes/${userId}/${safe}-${Date.now()}.png`;
  const qrCodeUrl = await uploadToS3(qrBuffer, fileKey);
  return qrCodeUrl;
};

/**
 * ---------------------------------------------------------
 * PROTECTED (requireAuth)
 * ---------------------------------------------------------
 */

const getMyBusinessCard = async (req, res) => {
  return res.status(400).json({
    error:
      "No default profile. Use GET /api/business-card/profiles and pick a profile_slug.",
    code: "NO_DEFAULT_PROFILE",
  });
};

// GET /api/business-card/profiles
const getMyProfiles = async (req, res) => {
  try {
    if (!req.user?._id) return res.status(401).json({ error: "Unauthorized" });

    const cards = await BusinessCard.find({ user: req.user._id }).sort({
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

    const slug = safeSlug(req.params.slug);
    if (!slug) return res.status(400).json({ error: "profile_slug required" });

    const card = await BusinessCard.findOne({
      user: req.user._id,
      profile_slug: slug,
    });

    return res.json({ data: card || null });
  } catch (err) {
    console.error("getMyProfileBySlug:", err);
    return res.status(500).json({ error: "Failed to fetch profile" });
  }
};

// POST /api/business-card/profiles
const createMyProfile = async (req, res) => {
  try {
    if (!req.user?._id) return res.status(401).json({ error: "Unauthorized" });

    const userId = req.user._id;

    const freshUser = await User.findById(userId).select(
      "plan planInterval subscriptionStatus isSubscribed trialExpires extraProfilesQty teamsProfilesQty username slug profileUrl qrCodeUrl"
    );

    const plan = getPlan(freshUser);
    const maxAllowed = getMaxProfilesForUser(freshUser);

    const slug = safeSlug(req.body.profile_slug);
    if (!slug || slug.length < 3) {
      return res
        .status(400)
        .json({ error: "profile_slug must be at least 3 characters" });
    }

    const count = await BusinessCard.countDocuments({ user: userId });
    if (count >= maxAllowed) {
      return upgradeRequired(res, {
        reason: "PROFILE_LIMIT",
        plan,
        maxProfiles: maxAllowed,
        currentProfiles: count,
        teamsProfilesQty: freshUser?.teamsProfilesQty || null,
        extraProfilesQty: freshUser?.extraProfilesQty || 0,
      });
    }

    const slugTaken = await BusinessCard.findOne({ profile_slug: slug }).select("_id");
    if (slugTaken) {
      return res.status(409).json({ error: "Profile slug already exists" });
    }

    const effectiveTemplate = normalizeTemplateForPlan(
      plan,
      req.body.template_id || "template-1"
    );

    const created = await BusinessCard.create({
      user: userId,
      profile_slug: slug,
      template_id: effectiveTemplate,
      business_card_name: req.body.business_card_name || "",
      business_name: req.body.business_name || req.body.business_card_name || "",
      theme_mode: req.body.theme_mode || req.body.page_theme || "light",
      page_theme: req.body.page_theme || req.body.theme_mode || "light",
      trade_title: req.body.trade_title || req.body.sub_heading || "",
      location: req.body.location || "",
      services: [],
      reviews: [],
      works: [],
      logo: "",
      avatar: "",
      cover_photo: "",
    });

    try {
      const qrUrl = await generateAndUploadProfileQr(userId, slug);
      if (qrUrl) {
        created.qr_code_url = qrUrl;
        await created.save();

        if (!freshUser?.qrCodeUrl) {
          await User.findByIdAndUpdate(userId, {
            $set: {
              qrCodeUrl: qrUrl,
              profileUrl: buildPublicProfileUrl(slug),
              slug: slug,
              username: freshUser?.username || slug,
            },
          });
        }
      }
    } catch (e) {
      console.error("QR generation failed (createMyProfile):", e);
    }

    return res.status(201).json({ data: created });
  } catch (err) {
    console.error("createMyProfile:", err);
    return res.status(500).json({ error: "Failed to create profile" });
  }
};

const setDefaultProfile = async (req, res) => {
  return res.status(400).json({
    error:
      "Default profile is not supported. Profiles are independent. Pick by profile_slug.",
    code: "NO_DEFAULT_PROFILE",
  });
};

// DELETE /api/business-card/profiles/:slug
const deleteMyProfile = async (req, res) => {
  try {
    if (!req.user?._id) return res.status(401).json({ error: "Unauthorized" });

    const userId = req.user._id;

    const slug = safeSlug(req.params.slug);
    if (!slug) return res.status(400).json({ error: "profile_slug required" });

    const card = await BusinessCard.findOne({ user: userId, profile_slug: slug });
    if (!card) return res.status(404).json({ error: "Profile not found" });

    await BusinessCard.deleteOne({ _id: card._id });

    return res.json({ success: true });
  } catch (err) {
    console.error("deleteMyProfile:", err);
    return res.status(500).json({ error: "Failed to delete profile" });
  }
};

// POST /api/business-card
const saveBusinessCard = async (req, res) => {
  try {
    if (!req.user?._id) return res.status(401).json({ error: "Unauthorized" });

    const userId = req.user._id;

    const freshUser = await User.findById(userId).select(
      "plan teamsProfilesQty extraProfilesQty username slug profileUrl qrCodeUrl"
    );
    const plan = getPlan(freshUser);
    const limits = getContentLimitsForPlan(plan);

    const requestedSlug = safeSlug(req.body.profile_slug || "");
    if (!requestedSlug || requestedSlug.length < 3) {
      return res.status(400).json({
        error: "profile_slug is required and must be at least 3 chars",
      });
    }

    const otherOwner = await BusinessCard.findOne({
      profile_slug: requestedSlug,
      user: { $ne: userId },
    }).select("_id");
    if (otherOwner) {
      return res.status(409).json({ error: "Profile slug already exists" });
    }

    let existingCard = await BusinessCard.findOne({
      user: userId,
      profile_slug: requestedSlug,
    });

    let targetQuery = { user: userId, profile_slug: requestedSlug };
    let willRenameSlug = false;

    if (!existingCard && plan !== "teams") {
      const count = await BusinessCard.countDocuments({ user: userId });
      if (count >= 1) {
        const onlyCard = await BusinessCard.findOne({ user: userId }).sort({
          createdAt: 1,
        });
        if (onlyCard?._id) {
          existingCard = onlyCard;
          targetQuery = { _id: onlyCard._id };
          willRenameSlug = true;
        }
      }
    }

    const debugFiles = {
      cover_photo: req.files?.cover_photo?.length || 0,
      logo: req.files?.logo?.length || 0,
      avatar: req.files?.avatar?.length || 0,
      works: req.files?.works?.length || 0,
      hasFilesObject: !!req.files,
    };

    let services = normalizeServices(req.body.services);
    let reviews = normalizeReviews(req.body.reviews);

    const existingWorksFromRequest = cleanStringArray([]
      .concat(req.body.existing_works || [])
      .flat());

    const coverRemoved = String(req.body.cover_photo_removed || "0") === "1";
    const avatarRemoved = String(req.body.avatar_removed || "0") === "1";
    const logoRemoved = String(req.body.logo_removed || "0") === "1" || avatarRemoved;

    let coverPhotoUrl = "";
    let avatarUrl = "";
    let logoUrl = "";

    if (req.files?.cover_photo?.[0]) {
      const f = req.files.cover_photo[0];
      const key = `cover_photos/${userId}/${Date.now()}-${f.originalname}`;
      coverPhotoUrl = await uploadToS3(f.buffer, key);
    }

    if (req.files?.logo?.[0]) {
      const f = req.files.logo[0];
      const key = `logos/${userId}/${Date.now()}-${f.originalname}`;
      logoUrl = await uploadToS3(f.buffer, key);
    }

    if (req.files?.avatar?.[0]) {
      const f = req.files.avatar[0];
      const key = `avatars/${userId}/${Date.now()}-${f.originalname}`;
      avatarUrl = await uploadToS3(f.buffer, key);
    }

    const uploadedWorkUrls = [];
    const workFiles = req.files?.works || [];

    const remainingWorkSlots = Math.max(0, limits.maxWorks - existingWorksFromRequest.length);
    const filesToUpload = workFiles.slice(0, remainingWorkSlots);

    for (const f of filesToUpload) {
      const key = `works/${userId}/${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}-${f.originalname}`;
      const url = await uploadToS3(f.buffer, key);
      if (url) uploadedWorkUrls.push(url);
    }

    let works = [...existingWorksFromRequest, ...uploadedWorkUrls];

    const clamped = clampPlanContent({
      plan,
      works,
      services,
      reviews,
    });

    works = clamped.works;
    services = clamped.services;
    reviews = clamped.reviews;

    const requestedTemplate =
      req.body.template_id || existingCard?.template_id || "template-1";
    const effectiveTemplate = normalizeTemplateForPlan(plan, requestedTemplate);

    const existingCover = norm(existingCard?.cover_photo);
    const existingAvatar = norm(existingCard?.avatar);
    const existingLogo = norm(existingCard?.logo);

    const update = {
      user: userId,
      profile_slug: requestedSlug,
      template_id: effectiveTemplate,

      business_card_name:
        req.body.business_card_name || req.body.business_name || "",
      business_name:
        req.body.business_name ||
        req.body.business_card_name ||
        req.body.main_heading ||
        "",

      trade_title: req.body.trade_title || req.body.sub_heading || "",
      location: req.body.location || "",

      main_heading: req.body.main_heading || req.body.business_name || "",
      sub_heading: req.body.sub_heading || req.body.trade_title || "",

      full_name: req.body.full_name || "",
      bio: req.body.bio || "",
      job_title: req.body.job_title || "",

      contact_email: req.body.contact_email || "",
      phone_number: req.body.phone_number || "",

      services,
      reviews,
      works,

      theme_mode: req.body.theme_mode || req.body.page_theme || "light",
      page_theme: req.body.page_theme || req.body.theme_mode || "light",
      page_theme_variant: req.body.page_theme_variant || "subtle-light",

      style: req.body.style || "Inter",

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

      button_bg_color: req.body.button_bg_color || "#F47629",
      button_text_color: req.body.button_text_color || "white",
      text_alignment: req.body.text_alignment || "left",

      facebook_url: req.body.facebook_url || "",
      instagram_url: req.body.instagram_url || "",
      linkedin_url: req.body.linkedin_url || "",
      x_url: req.body.x_url || "",
      tiktok_url: req.body.tiktok_url || "",

      section_order: parseJsonArray(req.body.section_order, [
        "main",
        "about",
        "work",
        "services",
        "reviews",
        "contact",
      ]),
    };

    // Cover photo: explicit remove > new upload > keep existing > empty
    if (coverRemoved) {
      update.cover_photo = "";
    } else if (coverPhotoUrl) {
      update.cover_photo = coverPhotoUrl;
    } else {
      update.cover_photo = existingCover;
    }

    // Logo/avatar:
    // - explicit remove clears both
    // - new logo upload becomes both logo + avatar for compatibility
    // - avatar upload without logo also becomes both
    // - otherwise preserve what existed
    if (logoRemoved) {
      update.logo = "";
      update.avatar = "";
    } else if (logoUrl) {
      update.logo = logoUrl;
      update.avatar = logoUrl;
    } else if (avatarUrl) {
      update.avatar = avatarUrl;
      update.logo = avatarUrl;
    } else {
      update.logo = existingLogo;
      update.avatar = existingAvatar || existingLogo;
    }

    if (willRenameSlug) {
      update.profile_slug = requestedSlug;
    }

    const allowUpsert = plan === "teams" || !existingCard;

    const saved = await BusinessCard.findOneAndUpdate(
      targetQuery,
      { $set: update },
      { new: true, upsert: allowUpsert }
    );

    try {
      const needsQr =
        !saved?.qr_code_url ||
        (willRenameSlug && safeSlug(saved.profile_slug) === requestedSlug);

      if (needsQr) {
        const qrUrl = await generateAndUploadProfileQr(userId, saved.profile_slug);
        if (qrUrl) {
          saved.qr_code_url = qrUrl;
          await saved.save();
        }
      }
    } catch (e) {
      console.error("QR ensure failed (saveBusinessCard):", e);
    }

    const setupComplete = hasMeaningfulProfileContent(saved);

    return res.json({
      data: saved,
      meta: {
        setup_complete: setupComplete,
      },
      debug: {
        filesReceived: debugFiles,
        cover_photo_saved: saved?.cover_photo || "",
        avatar_saved: saved?.avatar || "",
        logo_saved: saved?.logo || "",
        theme_mode_saved: saved?.theme_mode || "",
        trade_title_saved: saved?.trade_title || "",
        works_count: Array.isArray(saved?.works) ? saved.works.length : 0,
        services_count: Array.isArray(saved?.services) ? saved.services.length : 0,
        reviews_count: Array.isArray(saved?.reviews) ? saved.reviews.length : 0,
      },
      normalized: {
        plan,
        template_id: effectiveTemplate,
        limitsApplied: true,
        maxWorks: limits.maxWorks,
        maxServices: limits.maxServices,
        maxReviews: limits.maxReviews,
        renamedSingleProfile: !!willRenameSlug,
      },
    });
  } catch (err) {
    console.error("saveBusinessCard:", err);
    return res.status(500).json({ error: "Failed to save business card" });
  }
};

/**
 * ---------------------------------------------------------
 * PUBLIC
 * ---------------------------------------------------------
 */

const getPublicBySlug = async (req, res) => {
  try {
    const slug = safeSlug(req.params.slug);
    if (!slug) return res.status(400).json({ error: "slug required" });

    const card = await BusinessCard.findOne({ profile_slug: slug });
    if (!card) return res.status(404).json({ error: "Business card not found" });

    return res.json(card);
  } catch (err) {
    console.error("getPublicBySlug:", err);
    return res.status(500).json({ error: "Failed to fetch business card" });
  }
};

const getPublicByUsername = async (req, res) => {
  try {
    const username = String(req.params.username || "").trim();
    if (!username) return res.status(400).json({ error: "username required" });

    const user = await User.findOne({
      username: { $regex: new RegExp(`^${username}$`, "i") },
    }).select("_id username");

    if (!user) return res.status(404).json({ error: "User not found" });

    const main = await BusinessCard.findOne({
      user: user._id,
      profile_slug: "main",
    });
    if (main) return res.json(main);

    const newest = await BusinessCard.findOne({ user: user._id }).sort({
      updatedAt: -1,
    });
    if (!newest) return res.status(404).json({ error: "Business card not found" });

    return res.json(newest);
  } catch (err) {
    console.error("getPublicByUsername:", err);
    return res.status(500).json({ error: "Failed to fetch business card" });
  }
};

const getPublicByUsernameAndSlug = async (req, res) => {
  try {
    const username = String(req.params.username || "").trim();
    if (!username) return res.status(400).json({ error: "username required" });

    const slug = safeSlug(req.params.slug);
    if (!slug) return res.status(400).json({ error: "slug required" });

    const user = await User.findOne({
      username: { $regex: new RegExp(`^${username}$`, "i") },
    }).select("_id username");

    if (!user) return res.status(404).json({ error: "User not found" });

    const card = await BusinessCard.findOne({
      user: user._id,
      profile_slug: slug,
    });
    if (!card) return res.status(404).json({ error: "Business card not found" });

    return res.json(card);
  } catch (err) {
    console.error("getPublicByUsernameAndSlug:", err);
    return res.status(500).json({ error: "Failed to fetch business card" });
  }
};

module.exports = {
  getMyBusinessCard,
  saveBusinessCard,
  getMyProfiles,
  getMyProfileBySlug,
  createMyProfile,
  setDefaultProfile,
  deleteMyProfile,
  getPublicBySlug,
  getPublicByUsername,
  getPublicByUsernameAndSlug,
};