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

// ✅ QR generator
const QRCode = require("qrcode");

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

const cleanupUndefined = (obj) => {
    Object.keys(obj).forEach((k) => {
        if (typeof obj[k] === "undefined") delete obj[k];
    });
    return obj;
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

const safeSlug = (raw, fallback = "main") => {
    const s = (raw ?? "").toString().trim().toLowerCase();
    if (!s) return fallback;
    const cleaned = s
        .replace(/[^a-z0-9-_]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^[-_]+|[-_]+$/g, "");
    return cleaned || fallback;
};

const uploadToS3 = async ({ folder, file, contentTypeOverride }) => {
    const ext = path.extname(file.originalname || "") || "";
    const key = `${folder}/${uuidv4()}${ext}`;

    await s3.send(
        new PutObjectCommand({
            Bucket: process.env.AWS_CARD_BUCKET_NAME,
            Key: key,
            Body: file.buffer,
            ContentType: contentTypeOverride || file.mimetype,
        })
    );

    return s3UrlForKey(key);
};

// ✅ Upload raw buffer (QR png) to S3
const uploadBufferToS3 = async ({ folder, buffer, contentType = "image/png", ext = ".png" }) => {
    const key = `${folder}/${uuidv4()}${ext}`;

    await s3.send(
        new PutObjectCommand({
            Bucket: process.env.AWS_CARD_BUCKET_NAME,
            Key: key,
            Body: buffer,
            ContentType: contentType,
        })
    );

    return s3UrlForKey(key);
};

// ✅ Decide the public URL for a profile (default + slug routes)
const getPublicProfileUrl = ({ username, slug }) => {
    // If you ever want slug-specific public URLs:
    // - default profile uses /u/:username
    // - non-default uses /u/:username/:slug
    if (!username) return "";
    if (!slug || slug === "main") return `${process.env.PUBLIC_PROFILE_DOMAIN || "https://www.konarcard.com"}/u/${username}`;
    return `${process.env.PUBLIC_PROFILE_DOMAIN || "https://www.konarcard.com"}/u/${username}/${slug}`;
};

// ✅ Ensure QR exists for a given profile (creates if missing)
const ensureProfileQrCode = async ({ userId, profile_slug }) => {
    const user = await User.findById(userId).select("username");
    const username = (user?.username || "").toLowerCase().trim();
    if (!username) return null;

    const urlToEncode = getPublicProfileUrl({ username, slug: profile_slug });

    const pngBuffer = await QRCode.toBuffer(urlToEncode, {
        type: "png",
        width: 900,
        margin: 2,
        errorCorrectionLevel: "M",
    });

    const qrUrl = await uploadBufferToS3({
        folder: "qr_codes",
        buffer: pngBuffer,
        contentType: "image/png",
        ext: ".png",
    });

    return qrUrl;
};

// =========================================================
// ✅ NEW: List my profiles (JWT)
// GET /api/business-card/profiles
// Returns: { data: BusinessCard[] }
// =========================================================
router.get("/profiles", async (req, res) => {
    try {
        const { userId, error } = getAuthedUserId(req);
        if (error) return res.status(error.status).json(error.body);

        const cards = await BusinessCard.find({ user: userId }).sort({ is_default: -1, updatedAt: -1 });
        return res.status(200).json({ data: cards || [] });
    } catch (err) {
        console.error("Error listing my profiles (/profiles):", err);
        return res.status(500).json({ error: "Failed to fetch business card profiles" });
    }
});

// =========================================================
// ✅ NEW: Fetch a specific profile by slug (JWT)
// GET /api/business-card/profiles/:slug
// Returns: { data: BusinessCard|null }
// =========================================================
router.get("/profiles/:slug", async (req, res) => {
    try {
        const { userId, error } = getAuthedUserId(req);
        if (error) return res.status(error.status).json(error.body);

        const slug = safeSlug(req.params.slug, "main");
        const card = await BusinessCard.findOne({ user: userId, profile_slug: slug });
        return res.status(200).json({ data: card || null });
    } catch (err) {
        console.error("Error getting my profile (/profiles/:slug):", err);
        return res.status(500).json({ error: "Failed to fetch business card profile" });
    }
});

// =========================================================
// ✅ NEW: Create a new profile (JWT)
// POST /api/business-card/profiles
// Body: { profile_slug?, template_id?, business_card_name? }
// Returns: { message, data: createdCard }
// =========================================================
router.post("/profiles", async (req, res) => {
    try {
        const { userId, error } = getAuthedUserId(req);
        if (error) return res.status(error.status).json(error.body);

        const slug = safeSlug(req.body?.profile_slug, "profile");
        const templateId = (req.body?.template_id || "template-1").toString();

        const existing = await BusinessCard.findOne({ user: userId, profile_slug: slug });
        if (existing) {
            return res.status(409).json({ error: "Profile slug already exists" });
        }

        const isFirst = (await BusinessCard.countDocuments({ user: userId })) === 0;

        const allowedTemplates = ["template-1", "template-2", "template-3", "template-4", "template-5"];

        const card = await BusinessCard.create({
            user: userId,
            profile_slug: slug,
            is_default: isFirst,
            template_id: allowedTemplates.includes(templateId) ? templateId : "template-1",
            business_card_name: (req.body?.business_card_name || "").toString(),
        });

        // ✅ Create & attach QR immediately (per-profile)
        try {
            const qrUrl = await ensureProfileQrCode({ userId, profile_slug: slug });
            if (qrUrl) {
                card.qr_code_url = qrUrl;
                await card.save();
            }
        } catch (e) {
            console.error("QR creation failed for new profile:", e);
            // do not fail profile creation if QR fails
        }

        return res.status(201).json({ message: "Profile created", data: card });
    } catch (err) {
        console.error("Error creating profile (/profiles):", err);
        if (err?.code === 11000) {
            return res.status(409).json({ error: "Profile slug already exists" });
        }
        return res.status(500).json({ error: "Failed to create profile" });
    }
});

// =========================================================
// ✅ NEW: Set default profile (JWT)
// PATCH /api/business-card/profiles/:slug/default
// Returns: { message, data: updatedDefault }
// =========================================================
router.patch("/profiles/:slug/default", async (req, res) => {
    try {
        const { userId, error } = getAuthedUserId(req);
        if (error) return res.status(error.status).json(error.body);

        const slug = safeSlug(req.params.slug, "main");

        const card = await BusinessCard.findOne({ user: userId, profile_slug: slug });
        if (!card) return res.status(404).json({ error: "Profile not found" });

        await BusinessCard.updateMany({ user: userId, is_default: true }, { $set: { is_default: false } });
        card.is_default = true;
        await card.save();

        return res.status(200).json({ message: "Default profile updated", data: card });
    } catch (err) {
        console.error("Error setting default profile:", err);
        return res.status(500).json({ error: "Failed to set default profile" });
    }
});

// =========================================================
// ✅ NEW: Delete profile (JWT)
// DELETE /api/business-card/profiles/:slug
// =========================================================
router.delete("/profiles/:slug", async (req, res) => {
    try {
        const { userId, error } = getAuthedUserId(req);
        if (error) return res.status(error.status).json(error.body);

        const slug = safeSlug(req.params.slug, "main");

        const count = await BusinessCard.countDocuments({ user: userId });
        if (count <= 1) {
            return res.status(400).json({ error: "You must keep at least one profile." });
        }

        const card = await BusinessCard.findOneAndDelete({ user: userId, profile_slug: slug });
        if (!card) return res.status(404).json({ error: "Profile not found" });

        if (card.is_default) {
            const newest = await BusinessCard.findOne({ user: userId }).sort({ updatedAt: -1 });
            if (newest) {
                newest.is_default = true;
                await newest.save();
            }
        }

        return res.status(200).json({ message: "Profile deleted" });
    } catch (err) {
        console.error("Error deleting profile:", err);
        return res.status(500).json({ error: "Failed to delete profile" });
    }
});

// =========================================================
// ✅ Legacy/current "me" endpoint (kept for existing frontend)
// GET /api/business-card/me
// Returns: { data: card } or { data: null }
// - Always returns DEFAULT profile if exists, else "main", else newest
// =========================================================
router.get("/me", async (req, res) => {
    try {
        const { userId, error } = getAuthedUserId(req);
        if (error) return res.status(error.status).json(error.body);

        const card =
            (await BusinessCard.findOne({ user: userId, is_default: true })) ||
            (await BusinessCard.findOne({ user: userId, profile_slug: "main" })) ||
            (await BusinessCard.findOne({ user: userId }).sort({ updatedAt: -1 }));

        return res.status(200).json({ data: card || null });
    } catch (err) {
        console.error("Error getting my card (/me):", err);
        return res.status(500).json({ error: "Failed to fetch business card" });
    }
});

// =========================================================
// ✅ JWT-based UPSERT save (supports profile_slug)
// POST /api/business-card
// =========================================================
router.post("/", upload, async (req, res) => {
    try {
        const { userId, error } = getAuthedUserId(req);
        if (error) return res.status(error.status).json(error.body);

        const profile_slug = safeSlug(req.body?.profile_slug, "main");

        const existingCard = await BusinessCard.findOne({ user: userId, profile_slug });

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

            // optional extras
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

            // templates + default flag
            template_id,
            is_default,
        } = req.body;

        const parsedServices = parseJSONSafely(services, []);
        const parsedReviews = parseJSONSafely(reviews, []);
        const parsedSectionOrder = parseJSONSafely(section_order, []);

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

        // works
        const newWorkFiles = [...(req.files?.work_images || []), ...(req.files?.works || [])];
        if (newWorkFiles.length > 0) {
            for (const file of newWorkFiles) {
                const url = await uploadToS3({ folder: "work_images", file });
                workImageUrls.push(url);
            }
        }

        const coverRemoved = parseBool(cover_photo_removed);
        const avatarRemoved = parseBool(avatar_removed);

        const nextCover = coverPhotoUrl !== null ? coverPhotoUrl : coverRemoved === true ? "" : existingCard?.cover_photo || "";
        const nextAvatar = avatarUrl !== null ? avatarUrl : avatarRemoved === true ? "" : existingCard?.avatar || "";

        const showMain = parseBool(show_main_section);
        const showAbout = parseBool(show_about_me_section);
        const showWork = parseBool(show_work_section);
        const showServices = parseBool(show_services_section);
        const showReviews = parseBool(show_reviews_section);
        const showContact = parseBool(show_contact_section);

        const allowedTemplates = ["template-1", "template-2", "template-3", "template-4", "template-5"];
        const nextTemplate = allowedTemplates.includes((template_id || "").toString()) ? template_id : undefined;

        const wantsDefault = parseBool(is_default);

        const updateData = cleanupUndefined({
            profile_slug,
            template_id: nextTemplate,

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

            user: userId,

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
            { user: userId, profile_slug },
            updateData,
            { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
        );

        // If client requested "set as default"
        if (wantsDefault === true) {
            await BusinessCard.updateMany({ user: userId, is_default: true }, { $set: { is_default: false } });
            updatedCard.is_default = true;
            await updatedCard.save();
        }

        // ✅ SAFETY NET: if profile has no QR yet, generate it
        if (!updatedCard.qr_code_url) {
            try {
                const qrUrl = await ensureProfileQrCode({ userId, profile_slug });
                if (qrUrl) {
                    updatedCard.qr_code_url = qrUrl;
                    await updatedCard.save();
                }
            } catch (e) {
                console.error("QR creation failed on save:", e);
            }
        }

        return res.status(200).json({
            message: "Business card saved successfully",
            data: updatedCard,
        });
    } catch (err) {
        console.error("Upsert business card error:", err);

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
// Kept for backwards compatibility
// - Always writes to profile_slug="main"
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
        const existingCard = await BusinessCard.findOne({ user, profile_slug: "main" });

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

        let coverPhotoUrl = null;
        if (req.files?.cover_photo?.[0]) {
            coverPhotoUrl = await uploadToS3({
                folder: "cover_photos",
                file: req.files.cover_photo[0],
            });
        }

        let avatarUrl = null;
        if (req.files?.avatar?.[0]) {
            avatarUrl = await uploadToS3({
                folder: "avatars",
                file: req.files.avatar[0],
            });
        }

        const newWorkFiles = [...(req.files?.work_images || []), ...(req.files?.works || [])];
        if (newWorkFiles.length > 0) {
            for (const file of newWorkFiles) {
                const url = await uploadToS3({ folder: "work_images", file });
                workImageUrls.push(url);
            }
        }

        const coverRemoved = parseBool(cover_photo_removed);
        const avatarRemoved = parseBool(avatar_removed);

        const nextCover = coverPhotoUrl !== null ? coverPhotoUrl : coverRemoved === true ? "" : existingCard?.cover_photo || "";
        const nextAvatar = avatarUrl !== null ? avatarUrl : avatarRemoved === true ? "" : existingCard?.avatar || "";

        const updateData = {
            profile_slug: "main",
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
            user,
        };

        const updatedCard = await BusinessCard.findOneAndUpdate(
            { user, profile_slug: "main" },
            updateData,
            { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
        );

        // ✅ Ensure QR exists for main profile too
        if (!updatedCard.qr_code_url) {
            try {
                const qrUrl = await ensureProfileQrCode({ userId: user, profile_slug: "main" });
                if (qrUrl) {
                    updatedCard.qr_code_url = qrUrl;
                    await updatedCard.save();
                }
            } catch (e) {
                console.error("QR creation failed on legacy save:", e);
            }
        }

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
// Public profile fetch by username (DEFAULT profile)
// GET /api/business-card/by_username/:username
// =========================================================
router.get("/by_username/:username", async (req, res) => {
    try {
        const { username } = req.params;

        const user = await User.findOne({ username: username.toLowerCase().trim() });
        if (!user) return res.status(404).json({ message: "User not found" });

        const card =
            (await BusinessCard.findOne({ user: user._id, is_default: true })) ||
            (await BusinessCard.findOne({ user: user._id, profile_slug: "main" })) ||
            (await BusinessCard.findOne({ user: user._id }).sort({ updatedAt: -1 }));

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
// ✅ Public profile fetch by username + profile slug
// GET /api/business-card/by_username/:username/:slug
// =========================================================
router.get("/by_username/:username/:slug", async (req, res) => {
    try {
        const { username, slug } = req.params;

        const user = await User.findOne({ username: username.toLowerCase().trim() });
        if (!user) return res.status(404).json({ message: "User not found" });

        const profileSlug = safeSlug(slug, "main");
        const card = await BusinessCard.findOne({ user: user._id, profile_slug: profileSlug });

        if (!card) return res.status(404).json({ message: "Business card not found for this profile" });
        return res.status(200).json(card);
    } catch (err) {
        console.error("Error fetching business card by username+slug:", err);
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

        const card =
            (await BusinessCard.findOne({ user: userId, is_default: true })) ||
            (await BusinessCard.findOne({ user: userId, profile_slug: "main" })) ||
            (await BusinessCard.findOne({ user: userId }).sort({ updatedAt: -1 }));

        if (!card) return res.status(404).json({ error: "Business card not found" });

        return res.status(200).json(card);
    } catch (err) {
        console.error("Error getting my card:", err);
        return res.status(500).json({ error: "Failed to fetch business card" });
    }
});

module.exports = router;
