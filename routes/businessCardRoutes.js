// backend/routes/businessCardRoutes.js
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

// ✅ Model needed for slug availability check
const BusinessCard = require("../models/BusinessCard");

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
    files: 1 + 1 + 20,
    fileSize: 10 * 1024 * 1024,
  },
}).fields([
  { name: "cover_photo", maxCount: 1 },
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

// Create profile
router.post("/profiles", requireAuth, createMyProfile);

// Delete profile
router.delete("/profiles/:slug", requireAuth, deleteMyProfile);

// Legacy default endpoint (still returns 400 by design)
router.patch("/profiles/:slug/default", requireAuth, setDefaultProfile);

// Save profile (multipart)
router.post("/", requireAuth, upload, saveBusinessCard);

/* =========================================================
   ✅ SLUG AVAILABILITY CHECK (PUBLIC)
   GET /api/business-card/slug-available/:slug
   ========================================================= */
router.get("/slug-available/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim().toLowerCase();
    if (!slug) return res.status(400).json({ error: "slug required" });

    const exists = await BusinessCard.findOne({ profile_slug: slug }).select("_id");
    return res.json({ available: !exists });
  } catch (err) {
    console.error("slug-available:", err);
    return res.status(500).json({ error: "Failed to check slug" });
  }
});

/* =========================================================
   PUBLIC
   ========================================================= */

// Public by GLOBAL slug
router.get("/public/:slug", getPublicBySlug);

// Username-based public endpoints (RESTORED and ACTIVE)
router.get("/by_username/:username", getPublicByUsername);
router.get("/by_username/:username/:slug", getPublicByUsernameAndSlug);

module.exports = router;
