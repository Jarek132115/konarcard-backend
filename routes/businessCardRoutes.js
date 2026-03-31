const express = require("express");
const router = express.Router();
const multer = require("multer");

const { requireAuth } = require("../helpers/auth");

const {
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
} = require("../controllers/businessCardController");

// Models
const BusinessCard = require("../models/BusinessCard");
const ProfileAnalyticsEvent = require("../models/ProfileAnalyticsEvent");

/**
 * IMPORTANT:
 * profile_slug must match BusinessCard schema: /^[a-z0-9-]+$/
 * (hyphens only, NO underscore/dot)
 */
const safeProfileSlug = (v) =>
  String(v || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");

/* =========================================================
   HELPERS
   ========================================================= */
const safeStr = (v, max = 300) =>
  String(v || "")
    .trim()
    .slice(0, max);

const normalizeSourceType = (v) => {
  const x = String(v || "").trim().toLowerCase();
  if (["qr", "nfc", "direct", "social", "referral", "unknown"].includes(x)) return x;
  return "unknown";
};

const normalizeSourcePlatform = (v) => {
  const x = String(v || "").trim().toLowerCase();
  if (
    [
      "facebook",
      "instagram",
      "linkedin",
      "google",
      "tiktok",
      "x",
      "twitter",
      "whatsapp",
      "youtube",
      "other",
      "unknown",
    ].includes(x)
  ) {
    return x === "twitter" ? "x" : x;
  }
  return "unknown";
};

const normalizeEventType = (v) => {
  const x = String(v || "").trim().toLowerCase();
  if (
    [
      "profile_view",
      "contact_exchange_submitted",
      "contact_saved",
      "phone_clicked",
      "email_clicked",
      "website_clicked",
      "social_clicked",
    ].includes(x)
  ) {
    return x;
  }
  return "profile_view";
};

const getClientIp = (req) => {
  const xf =
    req.headers["x-forwarded-for"] ||
    req.headers["cf-connecting-ip"] ||
    req.socket?.remoteAddress ||
    "";
  return String(Array.isArray(xf) ? xf[0] : xf)
    .split(",")[0]
    .trim()
    .slice(0, 64);
};

/* =========================================================
   NO-CACHE (helps avoid weird 304/stale behavior on protected APIs)
   ========================================================= */
router.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

/* =========================================================
   MULTER (memory)
   ========================================================= */
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  if (!file?.mimetype?.startsWith("image/")) {
    return cb(new Error("Only image uploads are allowed."), false);
  }
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    files: 1 + 1 + 1 + 20,
    fileSize: 10 * 1024 * 1024,
  },
}).fields([
  { name: "cover_photo", maxCount: 1 },
  { name: "logo", maxCount: 1 },
  { name: "avatar", maxCount: 1 },
  { name: "works", maxCount: 20 },
]);

/* =========================================================
   ROUTES
   Base path: /api/business-card
   ========================================================= */

// Legacy compatibility
router.get("/me", requireAuth, getMyBusinessCard);

// Multi-profile (protected)
router.get("/profiles", requireAuth, getMyProfiles);
router.get("/profiles/:slug", requireAuth, getMyProfileBySlug);

// Create profile (manual create, not the webhook-created one)
router.post("/profiles", requireAuth, createMyProfile);

// Delete profile
router.delete("/profiles/:slug", requireAuth, deleteMyProfile);

// Legacy default endpoint (still returns 400 by design)
router.patch("/profiles/:slug/default", requireAuth, setDefaultProfile);

// Save profile (multipart)
router.post("/", requireAuth, upload, saveBusinessCard);

/* =========================================================
   SLUG AVAILABILITY CHECK (PUBLIC)
   GET /api/business-card/slug-available/:slug
   ========================================================= */
router.get("/slug-available/:slug", async (req, res) => {
  try {
    const slug = safeProfileSlug(req.params.slug);
    if (!slug || slug.length < 3) {
      return res.status(400).json({ error: "slug required (min 3 chars, a-z 0-9 hyphen)" });
    }

    const exists = await BusinessCard.findOne({ profile_slug: slug }).select("_id");
    return res.json({ available: !exists, normalized: slug });
  } catch (err) {
    console.error("slug-available:", err);
    return res.status(500).json({ error: "Failed to check slug" });
  }
});

/* =========================================================
   PUBLIC ANALYTICS TRACKING
   POST /api/business-card/public/:slug/track
   Body:
   {
     eventType,
     sourceType,
     sourcePlatform,
     referrer,
     utmSource,
     utmMedium,
     utmCampaign,
     utmTerm,
     utmContent,
     visitorId,
     sessionId,
     actionTarget,
     targetUrl
   }
   ========================================================= */
router.post("/public/:slug/track", async (req, res) => {
  try {
    const slug = safeProfileSlug(req.params.slug);
    if (!slug || slug.length < 3) {
      return res.status(400).json({ error: "Invalid profile slug" });
    }

    const businessCard = await BusinessCard.findOne({ profile_slug: slug })
      .select("_id user profile_slug")
      .lean();

    if (!businessCard?._id || !businessCard?.user) {
      return res.status(404).json({ error: "Profile not found" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};

    const eventType = normalizeEventType(body.eventType);
    const sourceType = normalizeSourceType(body.sourceType);
    const sourcePlatform = normalizeSourcePlatform(body.sourcePlatform);

    await ProfileAnalyticsEvent.create({
      owner_user: businessCard.user,
      business_card: businessCard._id,
      profile_slug: businessCard.profile_slug,

      event_type: eventType,
      source_type: sourceType,
      source_platform: sourcePlatform,

      referrer: safeStr(body.referrer, 1000),

      utm_source: safeStr(body.utmSource, 120).toLowerCase(),
      utm_medium: safeStr(body.utmMedium, 120).toLowerCase(),
      utm_campaign: safeStr(body.utmCampaign, 160).toLowerCase(),
      utm_term: safeStr(body.utmTerm, 160),
      utm_content: safeStr(body.utmContent, 160),

      visitor_id: safeStr(body.visitorId, 120),
      session_id: safeStr(body.sessionId, 120),

      action_target: safeStr(body.actionTarget, 120).toLowerCase(),
      target_url: safeStr(body.targetUrl, 1200),

      user_agent: safeStr(req.headers["user-agent"], 500),
      ip: getClientIp(req),
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("public profile analytics track error:", err);
    return res.status(500).json({ error: "Failed to track analytics event" });
  }
});

/* =========================================================
   PUBLIC
   ========================================================= */

// Public by GLOBAL slug (THIS is what /u/:slug should use on frontend)
router.get("/public/:slug", getPublicBySlug);

// Username-based public endpoints (kept for compatibility)
router.get("/by_username/:username", getPublicByUsername);
router.get("/by_username/:username/:slug", getPublicByUsernameAndSlug);

module.exports = router;