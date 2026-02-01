// backend/routes/businessCardRoutes.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const BusinessCard = require("../models/BusinessCard");
const User = require("../models/user");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { getTokenFromReq } = require("../helpers/auth");

// =============================
// AWS S3 Setup
// =============================
const s3 = new S3Client({
    region: process.env.AWS_CARD_BUCKET_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

const s3UrlForKey = (key) =>
    `https://${process.env.AWS_CARD_BUCKET_NAME}.s3.${process.env.AWS_CARD_BUCKET_REGION}.amazonaws.com/${key}`;

// =============================
// Multer setup (memory)
// - Accept images only
// - Accept BOTH legacy "work_images" and new "works"
// =============================
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
        files: 1 + 1 + 10 + 10, // cover + avatar + work_images + works
        fileSize: 10 * 1024 * 1024, // 10MB per file
    },
}).fields([
    { name: "cover_photo", maxCount: 1 },
    { name: "avatar", maxCount: 1 },
    { name: "work_images", maxCount: 10 }, // legacy
    { name: "works", maxCount: 10 }, // new
]);

// =============================
// Helpers
// =============================
const parseJSONSafely = (v, fallback) => {
    try {
        if (v === null || typeof v === "undefined" || v === "") return fallback;
        if (typeof v === "string") return JSON.parse(v);
        if (Array.isArray(v) || (v && typeof v === "object")) return v;
        return fallback;
    } catch {
        return fallback;
    }
};

// IMPORTANT: return undefined when value is missing (so we don't overwrite fields)
const parseBool = (v) => {
    if (typeof v === "undefined" || v === null || v === "") return undefined;
    if (v === true || v === "true" || v === "1" || v === 1) return true;
    if (v === false || v === "false" || v === "0" || v === 0) return false;
    return undefined;
};

const getAuthedUserId = (req) => {
    const token = getTokenFromReq(req);
    if (!token) return { error: { status: 401, body: { error: "Unauthorized" } } };

    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
        return { error: { status: 401, body: { error: "Invalid token" } } };
    }

    return { userId: decoded.id };
};

const uploadToS3 = async ({ folder, file }) => {
    const ext = path.extname(file.originalname || "") || "";
    const key = `${folder}/${uuidv4()}${ext}`;

    await s3.send(
        new PutObjectCommand({
            Bucket: process.env.AWS_CARD_BUCKET_NAME,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype,
        })
    );

    return s3UrlForKey(key);
};

const cleanupUndefined = (obj) => {
    Object.keys(obj).forEach((k) => {
        if (typeof obj[k] === "undefined") delete obj[k];
    });
    return obj;
};

// =========================================================
// ✅ JWT-based "me" endpoint
// GET /api/business-card/me
// Returns: { data: card } or { data: null }
// =========================================================
router.get("/me", async (req, res) => {
    try {
        const { userId, error } = getAuthedUserId(req);
        if (error) return res.status(error.status).json(error.body);

        const card = await BusinessCard.findOne({ user: userId });
        return res.status(200).json({ data: card || null });
    } catch (err) {
        console.error("Error getting my card (/me):", err);
        return res.status(500).json({ error: "Failed to fetch business card" });
    }
});

// =========================================================
// ✅ JWT-based UPSERT save
// POST /api/business-card
// - Uses token user id
// - Supports images
// - Accepts work images under: work_images OR works
// =========================================================
router.post("/", upload, async (req, res) => {
    try {
        const { userId, error } = getAuthedUserId(req);
        if (error) return res.status(error.status).json(error.body);

        const existingCard = await BusinessCard.findOne({ user: userId });

        const {
            business_card_name,
            page_theme,
            style,

            main_heading,
            sub_heading,
            bio,
            job_title,
            full_name,

            services,
            reviews,

            existing_works,

            contact_email,
            phone_number,

            // removal flags
            cover_photo_removed,
            avatar_removed,

            // optional extras (frontend may send)
            section_order,

            page_theme_variant,
            work_display_mode,
            services_display_mode,
            reviews_display_mode,
            about_me_layout,

            button_bg_color,
            button_text_color,
            text_alignment,

            facebook_url,
            instagram_url,
            linkedin_url,
            x_url,
            tiktok_url,

            show_main_section,
            show_about_me_section,
            show_work_section,
            show_services_section,
            show_reviews_section,
            show_contact_section,
        } = req.body;

        const parsedServices = parseJSONSafely(services, []);
        const parsedReviews = parseJSONSafely(reviews, []);
        const parsedSectionOrder = parseJSONSafely(section_order, []);

        // Existing works can be string or array (multiple FormData entries)
        const existingWorksArray = (() => {
            if (!existing_works) return [];
            if (Array.isArray(existing_works)) return existing_works;
            return [existing_works];
        })()
            .filter((url) => typeof url === "string" && url.trim())
            .filter((url) => !url.startsWith("blob:"));

        // Start with existing works (if provided), otherwise preserve DB works
        let workImageUrls =
            existingWorksArray.length > 0
                ? existingWorksArray
                : Array.isArray(existingCard?.works)
                    ? existingCard.works
                    : [];

        // Upload cover photo if present
        let coverPhotoUrl = null;
        if (req.files?.cover_photo?.[0]) {
            coverPhotoUrl = await uploadToS3({
                folder: "cover_photos",
                file: req.files.cover_photo[0],
            });
        }

        // Upload avatar if present
        let avatarUrl = null;
        if (req.files?.avatar?.[0]) {
            avatarUrl = await uploadToS3({
                folder: "avatars",
                file: req.files.avatar[0],
            });
        }

        // Upload work images if present (accept BOTH fields)
        const newWorkFiles = [
            ...(req.files?.work_images || []),
            ...(req.files?.works || []),
        ];

        if (newWorkFiles.length > 0) {
            for (const file of newWorkFiles) {
                const url = await uploadToS3({ folder: "work_images", file });
                workImageUrls.push(url);
            }
        }

        // Removal flags (only apply if no replacement uploaded)
        const coverRemoved = parseBool(cover_photo_removed);
        const avatarRemoved = parseBool(avatar_removed);

        const nextCover =
            coverPhotoUrl !== null
                ? coverPhotoUrl
                : coverRemoved === true
                    ? ""
                    : existingCard?.cover_photo || "";

        const nextAvatar =
            avatarUrl !== null
                ? avatarUrl
                : avatarRemoved === true
                    ? ""
                    : existingCard?.avatar || "";

        // Booleans for show_* (so we store true/false, not "true"/"false")
        const showMain = parseBool(show_main_section);
        const showAbout = parseBool(show_about_me_section);
        const showWork = parseBool(show_work_section);
        const showServices = parseBool(show_services_section);
        const showReviews = parseBool(show_reviews_section);
        const showContact = parseBool(show_contact_section);

        const updateData = cleanupUndefined({
            // core fields
            business_card_name: business_card_name ?? existingCard?.business_card_name ?? "",
            page_theme: page_theme ?? existingCard?.page_theme ?? "light",
            style: style ?? existingCard?.style ?? "Inter",

            main_heading: main_heading ?? existingCard?.main_heading ?? "",
            sub_heading: sub_heading ?? existingCard?.sub_heading ?? "",
            bio: bio ?? existingCard?.bio ?? "",
            job_title: job_title ?? existingCard?.job_title ?? "",
            full_name: full_name ?? existingCard?.full_name ?? "",

            works: workImageUrls,
            services: Array.isArray(parsedServices) ? parsedServices : [],
            reviews: Array.isArray(parsedReviews) ? parsedReviews : [],

            contact_email: contact_email ?? existingCard?.contact_email ?? "",
            phone_number: phone_number ?? existingCard?.phone_number ?? "",

            cover_photo: nextCover,
            avatar: nextAvatar,

            // IMPORTANT: ensure user set on insert
            user: userId,

            // Optional extra fields (will only persist if your schema includes them)
            page_theme_variant,
            work_display_mode,
            services_display_mode,
            reviews_display_mode,
            about_me_layout,

            button_bg_color,
            button_text_color,
            text_alignment,

            facebook_url,
            instagram_url,
            linkedin_url,
            x_url,
            tiktok_url,

            show_main_section: showMain,
            show_about_me_section: showAbout,
            show_work_section: showWork,
            show_services_section: showServices,
            show_reviews_section: showReviews,
            show_contact_section: showContact,

            section_order: Array.isArray(parsedSectionOrder) ? parsedSectionOrder : undefined,
        });

        const updatedCard = await BusinessCard.findOneAndUpdate(
            { user: userId },
            updateData,
            { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
        );

        return res.status(200).json({
            message: "Business card saved successfully",
            data: updatedCard,
        });
    } catch (err) {
        console.error("Upsert business card error:", err);

        // Multer / fileFilter errors come through here too
        const msg = err?.message || err?.toString() || "Internal server error";
        const status = /only image uploads/i.test(msg) ? 400 : 500;

        return res.status(status).json({
            message: "Internal server error",
            error: msg,
        });
    }
});

// =========================================================
// LEGACY: POST /api/business-card/create_business_card
// Kept for backwards compatibility (older frontend)
// - Requires "user" in body
// - Accepts work images under work_images OR works
// =========================================================
router.post("/create_business_card", upload, async (req, res) => {
    try {
        const {
            business_card_name,
            page_theme,
            style,
            main_heading,
            sub_heading,
            user,
            bio,
            job_title,
            full_name,
            services,
            reviews,
            existing_works,
            contact_email,
            phone_number,
            cover_photo_removed,
            avatar_removed,
        } = req.body;

        if (!user) {
            return res.status(400).json({ message: "Missing required user field" });
        }

        const parsedServices = parseJSONSafely(services, []);
        const parsedReviews = parseJSONSafely(reviews, []);
        const existingCard = await BusinessCard.findOne({ user });

        const existingWorksArray = (() => {
            if (!existing_works) return [];
            if (Array.isArray(existing_works)) return existing_works;
            return [existing_works];
        })()
            .filter((url) => typeof url === "string" && url.trim())
            .filter((url) => !url.startsWith("blob:"));

        let workImageUrls =
            existingWorksArray.length > 0
                ? existingWorksArray
                : Array.isArray(existingCard?.works)
                    ? existingCard.works
                    : [];

        // cover
        let coverPhotoUrl = null;
        if (req.files?.cover_photo?.[0]) {
            coverPhotoUrl = await uploadToS3({
                folder: "cover_photos",
                file: req.files.cover_photo[0],
            });
        }

        // avatar
        let avatarUrl = null;
        if (req.files?.avatar?.[0]) {
            avatarUrl = await uploadToS3({
                folder: "avatars",
                file: req.files.avatar[0],
            });
        }

        // works (both fields)
        const newWorkFiles = [
            ...(req.files?.work_images || []),
            ...(req.files?.works || []),
        ];

        if (newWorkFiles.length > 0) {
            for (const file of newWorkFiles) {
                const url = await uploadToS3({ folder: "work_images", file });
                workImageUrls.push(url);
            }
        }

        const coverRemoved = parseBool(cover_photo_removed);
        const avatarRemoved = parseBool(avatar_removed);

        const nextCover =
            coverPhotoUrl !== null
                ? coverPhotoUrl
                : coverRemoved === true
                    ? ""
                    : existingCard?.cover_photo || "";

        const nextAvatar =
            avatarUrl !== null
                ? avatarUrl
                : avatarRemoved === true
                    ? ""
                    : existingCard?.avatar || "";

        const updateData = {
            business_card_name,
            page_theme,
            style,
            main_heading,
            sub_heading,
            bio,
            job_title,
            full_name,
            works: workImageUrls,
            services: Array.isArray(parsedServices) ? parsedServices : [],
            reviews: Array.isArray(parsedReviews) ? parsedReviews : [],
            cover_photo: nextCover,
            avatar: nextAvatar,
            contact_email,
            phone_number,
            user, // ensure user set
        };

        const updatedCard = await BusinessCard.findOneAndUpdate(
            { user },
            updateData,
            { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
        );

        return res.status(200).json({
            message: "Business card saved successfully",
            data: updatedCard,
        });
    } catch (err) {
        console.error("Create business card error:", err);
        const msg = err?.message || err?.toString() || "Internal server error";
        const status = /only image uploads/i.test(msg) ? 400 : 500;

        return res.status(status).json({
            message: "Internal server error",
            error: msg,
        });
    }
});

// =========================================================
// Public profile fetch by username
// GET /api/business-card/by_username/:username
// =========================================================
router.get("/by_username/:username", async (req, res) => {
    try {
        const { username } = req.params;

        const user = await User.findOne({ username: username.toLowerCase().trim() });
        if (!user) return res.status(404).json({ message: "User not found" });

        const card = await BusinessCard.findOne({ user: user._id });
        if (!card) {
            return res.status(404).json({ message: "Business card not found for this user" });
        }

        return res.status(200).json(card);
    } catch (err) {
        console.error("Error fetching business card by username:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
});

// =========================================================
// Legacy JWT-based "my_card" endpoint (kept)
// GET /api/business-card/my_card
// Returns: card object directly (legacy shape)
// =========================================================
router.get("/my_card", async (req, res) => {
    try {
        const { userId, error } = getAuthedUserId(req);
        if (error) return res.status(error.status).json(error.body);

        const card = await BusinessCard.findOne({ user: userId });
        if (!card) return res.status(404).json({ error: "Business card not found" });

        return res.status(200).json(card);
    } catch (err) {
        console.error("Error getting my card:", err);
        return res.status(500).json({ error: "Failed to fetch business card" });
    }
});

module.exports = router;
