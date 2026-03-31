const express = require("express");
const router = express.Router();

const BusinessCard = require("../models/BusinessCard");
const ProfileAnalyticsEvent = require("../models/ProfileAnalyticsEvent");

const ALLOWED_EVENT_TYPES = new Set([
    "profile_view",
    "qr_scan",
    "nfc_tap",
    "link_open",
    "contact_save",
    "contact_exchange",
    "contact_exchange_opened",
    "email_clicked",
    "phone_clicked",
    "social_clicked",
]);

const ALLOWED_SOURCES = new Set([
    "qr",
    "nfc",
    "direct",
    "link",
    "unknown",
]);

const ALLOWED_PLATFORMS = new Set([
    "facebook",
    "instagram",
    "linkedin",
    "x",
    "tiktok",
    "google",
    "other",
    "",
]);

function cleanString(v) {
    return String(v || "").trim();
}

function cleanSlug(v) {
    return String(v || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}

function cleanEventType(v) {
    const value = cleanString(v).toLowerCase();
    return ALLOWED_EVENT_TYPES.has(value) ? value : "";
}

function cleanSource(v) {
    const value = cleanString(v).toLowerCase();
    return ALLOWED_SOURCES.has(value) ? value : "unknown";
}

function cleanPlatform(v) {
    const value = cleanString(v).toLowerCase();
    return ALLOWED_PLATFORMS.has(value) ? value : "other";
}

function getClientIp(req) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.trim()) {
        return xff.split(",")[0].trim().slice(0, 64);
    }

    return (
        req.ip ||
        req.connection?.remoteAddress ||
        req.socket?.remoteAddress ||
        ""
    )
        .toString()
        .slice(0, 64);
}

function pickMeta(rawMeta = {}) {
    if (!rawMeta || typeof rawMeta !== "object" || Array.isArray(rawMeta)) {
        return {};
    }

    const meta = {};

    const actionTarget = cleanString(rawMeta.actionTarget).slice(0, 80);
    const targetUrl = cleanString(rawMeta.targetUrl).slice(0, 500);
    const referrer = cleanString(rawMeta.referrer).slice(0, 500);
    const pageUrl = cleanString(rawMeta.pageUrl).slice(0, 500);
    const querySource = cleanString(rawMeta.querySource).slice(0, 80);
    const cardId = cleanString(rawMeta.cardId).slice(0, 80);
    const productKey = cleanString(rawMeta.productKey).slice(0, 80);

    if (actionTarget) meta.actionTarget = actionTarget;
    if (targetUrl) meta.targetUrl = targetUrl;
    if (referrer) meta.referrer = referrer;
    if (pageUrl) meta.pageUrl = pageUrl;
    if (querySource) meta.querySource = querySource;
    if (cardId) meta.cardId = cardId;
    if (productKey) meta.productKey = productKey;

    return meta;
}

/**
 * POST /api/analytics/track
 * Public endpoint
 *
 * Body:
 * {
 *   profileSlug: "powerline-experts",
 *   eventType: "profile_view",
 *   source: "qr" | "nfc" | "direct" | "link" | "unknown",
 *   platform: "facebook" | "instagram" | "linkedin" | "x" | "tiktok" | "google" | "other",
 *   meta: { ... }
 * }
 */
router.post("/track", async (req, res) => {
    try {
        const profileSlug = cleanSlug(req.body?.profileSlug);
        const eventType = cleanEventType(req.body?.eventType);
        const source = cleanSource(req.body?.source);
        const platform = cleanPlatform(req.body?.platform);
        const meta = pickMeta(req.body?.meta);

        if (!profileSlug || profileSlug.length < 3) {
            return res.status(400).json({
                error: "Valid profileSlug is required",
                code: "INVALID_PROFILE_SLUG",
            });
        }

        if (!eventType) {
            return res.status(400).json({
                error: "Valid eventType is required",
                code: "INVALID_EVENT_TYPE",
            });
        }

        const businessCard = await BusinessCard.findOne({
            profile_slug: profileSlug,
        })
            .select("_id user profile_slug")
            .lean();

        if (!businessCard?._id || !businessCard?.user) {
            return res.status(404).json({
                error: "Profile not found",
                code: "PROFILE_NOT_FOUND",
            });
        }

        const userAgent = cleanString(req.headers["user-agent"]).slice(0, 300);
        const ip = getClientIp(req);

        await ProfileAnalyticsEvent.create({
            owner_user: businessCard.user,
            business_card: businessCard._id,
            profile_slug: businessCard.profile_slug,
            event_type: eventType,
            source,
            platform,
            meta,
            ip,
            user_agent: userAgent,
        });

        return res.json({ ok: true });
    } catch (err) {
        console.error("POST /api/analytics/track error:", err);
        return res.status(500).json({
            error: "Failed to track analytics event",
        });
    }
});

module.exports = router;