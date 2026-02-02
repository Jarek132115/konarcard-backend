// backend/routes/businessCardRoutes.js
const express = require("express");
const router = express.Router();
const multer = require("multer");

// ✅ Use your real auth middleware (single source of truth)
const { requireAuth } = require("../helpers/auth");

// ✅ Controller (matches the version you pasted)
const {
  // protected
  getMyBusinessCard, // compatibility stub (no default profile)
  saveBusinessCard,
  getMyProfiles,
  getMyProfileBySlug,
  createMyProfile,
  setDefaultProfile, // compatibility stub
  deleteMyProfile,

  // public
  getPublicBySlug,
  getPublicByUsername, // deprecated stub
  getPublicByUsernameAndSlug, // deprecated stub
} = require("../controllers/businessCardController");

/* =========================================================
   MULTER (memory) — production safe
   - images only
   - reasonable limits
   - fields match controller expectations
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
    files: 1 + 1 + 20, // cover + avatar + works
    fileSize: 10 * 1024 * 1024, // 10MB per file
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

// Legacy compatibility (old frontend may still call /me)
router.get("/me", requireAuth, getMyBusinessCard);

// Multi-profile system (protected)
router.get("/profiles", requireAuth, getMyProfiles);
router.get("/profiles/:slug", requireAuth, getMyProfileBySlug);

// Create profile (JSON body)
router.post("/profiles", requireAuth, createMyProfile);

// Delete profile
router.delete("/profiles/:slug", requireAuth, deleteMyProfile);

// Legacy default endpoint (explicitly not supported; returns 400)
router.patch("/profiles/:slug/default", requireAuth, setDefaultProfile);

// Save profile (multipart/form-data)
router.post("/", requireAuth, upload, saveBusinessCard);

/* =========================================================
   PUBLIC
   ========================================================= */

// ✅ Public profile by GLOBAL slug for www.konarcard.com/u/:slug
router.get("/public/:slug", getPublicBySlug);

// Deprecated username endpoints (kept for compatibility; return 400)
router.get("/by_username/:username", getPublicByUsername);
router.get("/by_username/:username/:slug", getPublicByUsernameAndSlug);

module.exports = router;
