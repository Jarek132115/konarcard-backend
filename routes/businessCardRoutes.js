// backend/routes/businessCardRoutes.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const jwt = require("jsonwebtoken");

const User = require("../models/user");
const { getTokenFromReq } = require("../helpers/auth");

// ✅ Controller (the new file you replaced)
const bc = require("../controllers/businessCardController");

/**
 * -----------------------------
 * Auth middleware (hydrates req.user)
 * -----------------------------
 */
const requireAuth = async (req, res, next) => {
  try {
    const token = getTokenFromReq(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: "Invalid token" });
    }

    const user = await User.findById(decoded.id);
    if (!user) return res.status(401).json({ error: "User not found" });

    req.user = user;
    return next();
  } catch (err) {
    console.error("requireAuth error:", err);
    return res.status(500).json({ error: "Auth failed" });
  }
};

/**
 * -----------------------------
 * Multer (memory) for images
 * - Accept cover_photo, avatar
 * - Accept works (new) and work_images (legacy)
 * -----------------------------
 */
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
    fileSize: 10 * 1024 * 1024, // 10MB each
  },
}).fields([
  { name: "cover_photo", maxCount: 1 },
  { name: "avatar", maxCount: 1 },
  { name: "works", maxCount: 10 }, // new
  { name: "work_images", maxCount: 10 }, // legacy
]);

/**
 * =========================================================
 * PROTECTED
 * =========================================================
 */

// Default card for logged-in user
router.get("/me", requireAuth, bc.getMyBusinessCard);

// Save/upsert (supports profile_slug)
router.post("/", requireAuth, upload, bc.saveBusinessCard);

// Multi-profile management
router.get("/profiles", requireAuth, bc.getMyProfiles);
router.get("/profiles/:slug", requireAuth, bc.getMyProfileBySlug);
router.post("/profiles", requireAuth, bc.createMyProfile);
router.patch("/profiles/:slug/default", requireAuth, bc.setDefaultProfile);
router.delete("/profiles/:slug", requireAuth, bc.deleteMyProfile);

/**
 * =========================================================
 * PUBLIC
 * =========================================================
 */
router.get("/by_username/:username", bc.getPublicByUsername);
router.get("/by_username/:username/:slug", bc.getPublicByUsernameAndSlug);

/**
 * =========================================================
 * LEGACY COMPAT (safe)
 * =========================================================
 */

// Legacy endpoint used by older frontend code (returns card object directly)
router.get("/my_card", requireAuth, async (req, res) => {
  try {
    const card = await (async () => {
      // reuse controller behavior
      // controller returns { data: card }
      let jsonResult;
      const fakeRes = {
        json: (obj) => (jsonResult = obj),
        status: () => fakeRes,
      };
      await bc.getMyBusinessCard(req, fakeRes);
      return jsonResult?.data ?? null;
    })();

    if (!card) return res.status(404).json({ error: "Business card not found" });
    return res.json(card);
  } catch (err) {
    console.error("legacy /my_card error:", err);
    return res.status(500).json({ error: "Failed to fetch business card" });
  }
});

// Legacy create endpoint (forces main profile, still requires auth)
router.post("/create_business_card", requireAuth, upload, async (req, res) => {
  req.body.profile_slug = "main";
  return bc.saveBusinessCard(req, res);
});

module.exports = router;
