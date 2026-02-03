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

// ✅ IMPORTANT: must match BusinessCard model validation:
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

const getPlan = (userDoc) => {
  const plan = String(userDoc?.plan || "free").toLowerCase();
  if (plan === "plus" || plan === "teams") return plan;
  return "free";
};

// ✅ Free limits exist, but saving must NEVER 403 because of them.
// We clamp content to the free limits instead.
const FREE_LIMIT = 6;

const upgradeRequired = (res, payload = {}) => {
  return res.status(403).json({
    code: "UPGRADE_REQUIRED",
    ...payload,
  });
};

/**
 * Clamp free plan content to limits (never block saving).
 */
const clampFreeContent = ({ plan, works, services, reviews }) => {
  if (plan !== "free") return { works, services, reviews };

  const safeArr = (a) => (Array.isArray(a) ? a : []).filter(Boolean);

  return {
    works: safeArr(works).slice(0, FREE_LIMIT),
    services: safeArr(services).slice(0, FREE_LIMIT),
    reviews: safeArr(reviews).slice(0, FREE_LIMIT),
  };
};

/**
 * Force free plan template to template-1 (never block saving).
 * Plus + Teams can use all 5 templates.
 */
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
  return t; // plus/teams
};

/**
 * ✅ Profile limits (YOUR REQUIREMENT):
 * - free: 1 profile
 * - plus: 1 profile (but all 5 templates)
 * - teams: multiple profiles (based on Stripe quantity)
 *
 * We support BOTH fields, because your DB shows both:
 * - teamsProfilesQty (your current source of truth)
 * - extraProfilesQty (in case you switch to "base+extra" later)
 *
 * Current behavior:
 * - If teamsProfilesQty is set => use it as total allowed profiles
 * - Else fallback to (1 + extraProfilesQty)
 */
const getMaxProfilesForUser = (userDoc) => {
  const plan = getPlan(userDoc);

  if (plan !== "teams") return 1;

  const teamsQty = Number(userDoc?.teamsProfilesQty);
  if (Number.isFinite(teamsQty) && teamsQty > 0) return Math.max(1, teamsQty);

  const extra = Number(userDoc?.extraProfilesQty);
  const extraSafe = Number.isFinite(extra) ? Math.max(0, extra) : 0;
  return 1 + extraSafe;
};

/**
 * ---------------------------------------------------------
 * ✅ QR helpers (each BusinessCard gets its own QR)
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
  const fileKey = `qr-codes/${userId}/${safe}-${Date.now()}.png`; // unique to avoid caching
  const qrCodeUrl = await uploadToS3(qrBuffer, fileKey);
  return qrCodeUrl;
};

/**
 * ---------------------------------------------------------
 * PROTECTED (requireAuth)
 * ---------------------------------------------------------
 */

// Legacy stub
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

// POST /api/business-card/profiles (create profile)
const createMyProfile = async (req, res) => {
  try {
    if (!req.user?._id) return res.status(401).json({ error: "Unauthorized" });

    const userId = req.user._id;

    // ✅ Always read fresh user from DB (webhook may have just updated plan)
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

    // ✅ Profile cap enforced ONLY here
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

    // ✅ GLOBAL slug uniqueness
    const slugTaken = await BusinessCard.findOne({ profile_slug: slug }).select(
      "_id"
    );
    if (slugTaken)
      return res.status(409).json({ error: "Profile slug already exists" });

    // ✅ Never 403 for template. Normalize instead.
    const effectiveTemplate = normalizeTemplateForPlan(
      plan,
      req.body.template_id || "template-1"
    );

    // ✅ Create profile
    const created = await BusinessCard.create({
      user: userId,
      profile_slug: slug,
      template_id: effectiveTemplate,
      business_card_name: req.body.business_card_name || "",
    });

    // ✅ Generate QR + save to this BusinessCard (ALWAYS for any created profile)
    try {
      const qrUrl = await generateAndUploadProfileQr(userId, slug);
      if (qrUrl) {
        created.qr_code_url = qrUrl;
        await created.save();

        // If this is the user's first profile OR user has no "main qr", store legacy "main qr" too
        // (helps older UI pieces that still read user.qrCodeUrl)
        if (!freshUser?.qrCodeUrl) {
          await User.findByIdAndUpdate(userId, {
            $set: {
              qrCodeUrl: qrUrl,
              // Keep legacy url field in sync (optional)
              profileUrl: buildPublicProfileUrl(slug),
              slug: slug,
              username: freshUser?.username || slug,
            },
          });
        }
      }
    } catch (e) {
      // Do not fail creation if QR generation fails
      console.error("QR generation failed (createMyProfile):", e);
    }

    // ✅ We DO NOT sync Stripe quantity from profile count here.
    // Stripe quantity (teamsProfilesQty) is the source of truth for Teams.

    return res.status(201).json({ data: created });
  } catch (err) {
    console.error("createMyProfile:", err);
    return res.status(500).json({ error: "Failed to create profile" });
  }
};

// Legacy stub
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

    // ✅ We DO NOT sync Stripe quantity from profile count here.

    return res.json({ success: true });
  } catch (err) {
    console.error("deleteMyProfile:", err);
    return res.status(500).json({ error: "Failed to delete profile" });
  }
};

// POST /api/business-card (upsert save, supports profile_slug)
// RULES:
// - Saving edits must ALWAYS work for ALL plans (free/plus/teams)
// - Free plan limits still apply (clamp + normalize), but never 403
// - Teams supports multiple profiles
// - Free/Plus should not be able to create 2nd profile via SAVE:
//   if they already have 1 profile and try to save another slug, we update their only profile instead.
const saveBusinessCard = async (req, res) => {
  try {
    if (!req.user?._id) return res.status(401).json({ error: "Unauthorized" });

    const userId = req.user._id;

    // ✅ Fresh user
    const freshUser = await User.findById(userId).select(
      "plan teamsProfilesQty extraProfilesQty username slug profileUrl qrCodeUrl"
    );
    const plan = getPlan(freshUser);

    const requestedSlug = safeSlug(req.body.profile_slug || "");
    if (!requestedSlug || requestedSlug.length < 3) {
      return res.status(400).json({
        error: "profile_slug is required and must be at least 3 chars",
      });
    }

    // GLOBAL slug protection (never allow two different owners)
    const otherOwner = await BusinessCard.findOne({
      profile_slug: requestedSlug,
      user: { $ne: userId },
    }).select("_id");
    if (otherOwner) {
      return res.status(409).json({ error: "Profile slug already exists" });
    }

    // Try to find the exact profile by slug
    let existingCard = await BusinessCard.findOne({
      user: userId,
      profile_slug: requestedSlug,
    }).select("_id profile_slug template_id works services reviews qr_code_url");

    // If not found and plan only allows 1 profile, fall back to the user's only profile
    let targetQuery = { user: userId, profile_slug: requestedSlug };
    let willRenameSlug = false;

    if (!existingCard && plan !== "teams") {
      const count = await BusinessCard.countDocuments({ user: userId });

      if (count >= 1) {
        const onlyCard = await BusinessCard.findOne({ user: userId })
          .sort({ createdAt: 1 })
          .select("_id profile_slug template_id works services reviews qr_code_url");

        if (onlyCard?._id) {
          existingCard = onlyCard;
          targetQuery = { _id: onlyCard._id };
          willRenameSlug = true;
        }
      }
    }

    // Arrays from FormData
    let services = parseJsonArray(req.body.services, []);
    let reviews = parseJsonArray(req.body.reviews, []);

    // existing_works can come as repeated fields
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

    // Upload new work images (respect free limit BEFORE uploading)
    const uploadedWorkUrls = [];
    const workFiles = req.files?.works || [];

    const maxWorks = plan === "free" ? FREE_LIMIT : Infinity;

    let works = [...existing_works].filter(Boolean);
    const remainingSlots = Math.max(
      0,
      maxWorks === Infinity ? workFiles.length : maxWorks - works.length
    );
    const filesToUpload =
      plan === "free" ? workFiles.slice(0, remainingSlots) : workFiles;

    for (const f of filesToUpload) {
      const key = `works/${userId}/${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}-${f.originalname}`;
      const url = await uploadToS3(f.buffer, key);
      if (url) uploadedWorkUrls.push(url);
    }

    works = [...works, ...uploadedWorkUrls];

    // Clamp free plan content instead of blocking
    ({ works, services, reviews } = clampFreeContent({
      plan,
      works,
      services,
      reviews,
    }));

    // Template normalize (free => template-1)
    const requestedTemplate =
      req.body.template_id || existingCard?.template_id || "template-1";
    const effectiveTemplate = normalizeTemplateForPlan(plan, requestedTemplate);

    const update = {
      user: userId,

      // ✅ If free/plus user tried to save to a new slug, we "rename" their single profile
      profile_slug: willRenameSlug ? requestedSlug : requestedSlug,

      template_id: effectiveTemplate,

      business_card_name: req.body.business_card_name || "",
      page_theme: req.body.page_theme || "light",
      page_theme_variant: req.body.page_theme_variant || "subtle-light",
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

      works,
    };

    // Handle removals
    const coverRemoved = asBool(req.body.cover_photo_removed, false);
    const avatarRemoved = asBool(req.body.avatar_removed, false);

    if (coverRemoved) update.cover_photo = "";
    if (avatarRemoved) update.avatar = "";

    if (cover_photo_url) update.cover_photo = cover_photo_url;
    if (avatar_url) update.avatar = avatar_url;

    // ✅ Upsert only if teams (or user has no card yet)
    // For free/plus we prefer updating the only card (handled above).
    const allowUpsert = plan === "teams" || !existingCard;

    const saved = await BusinessCard.findOneAndUpdate(
      targetQuery,
      { $set: update },
      { new: true, upsert: allowUpsert }
    );

    // ✅ Ensure QR exists for this profile.
    // Also: if free/plus "renamed" their single profile slug, generate a new QR for the new URL.
    try {
      const needsQr =
        !saved?.qr_code_url || (willRenameSlug && safeSlug(saved.profile_slug) === requestedSlug);

      if (needsQr) {
        const qrUrl = await generateAndUploadProfileQr(userId, saved.profile_slug);
        if (qrUrl) {
          saved.qr_code_url = qrUrl;
          await saved.save();

          // If free/plus renames their only profile, sync legacy user fields too
          if (plan !== "teams" && willRenameSlug) {
            await User.findByIdAndUpdate(userId, {
              $set: {
                username: requestedSlug,
                slug: requestedSlug,
                profileUrl: buildPublicProfileUrl(requestedSlug),
                qrCodeUrl: qrUrl,
              },
            });
          }
        }
      }
    } catch (e) {
      console.error("QR ensure failed (saveBusinessCard):", e);
    }

    return res.json({
      data: saved,
      normalized: {
        plan,
        template_id: effectiveTemplate,
        limitsApplied: plan === "free",
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

// ✅ Public profile by GLOBAL slug
// This is the canonical public lookup for /u/:profile_slug
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

// Legacy support (old route): GET /api/business-card/by_username/:username
// Returns "main" if exists, otherwise newest.
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

// Legacy support (old route): GET /api/business-card/by_username/:username/:slug
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
  // protected
  getMyBusinessCard,
  saveBusinessCard,

  getMyProfiles,
  getMyProfileBySlug,
  createMyProfile,
  setDefaultProfile,
  deleteMyProfile,

  // public
  getPublicBySlug,
  getPublicByUsername,
  getPublicByUsernameAndSlug,
};
