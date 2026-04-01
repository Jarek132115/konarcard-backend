const express = require("express");
const router = express.Router();

const BusinessCard = require("../models/BusinessCard");
const ProfileAnalyticsEvent = require("../models/ProfileAnalyticsEvent");
const { requireAuth } = require("../helpers/auth");

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

const ALLOWED_SOURCE_TYPES = new Set([
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
    "unknown",
    "",
]);

const VIEW_EVENT_TYPES = ["profile_view", "qr_scan", "nfc_tap", "link_open"];
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

function cleanString(v) {
    return String(v || "").trim();
}

function cleanLowerString(v) {
    return cleanString(v).toLowerCase();
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
    const value = cleanLowerString(v);
    return ALLOWED_EVENT_TYPES.has(value) ? value : "";
}

function cleanSourceType(v) {
    const value = cleanLowerString(v);
    return ALLOWED_SOURCE_TYPES.has(value) ? value : "unknown";
}

function cleanPlatform(v) {
    const value = cleanLowerString(v);
    return ALLOWED_PLATFORMS.has(value) ? value : "unknown";
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

function parseUrlSafe(urlValue) {
    try {
        if (!urlValue || typeof urlValue !== "string") return null;
        return new URL(urlValue);
    } catch {
        return null;
    }
}

function detectPlatformFromReferrer(referrer = "", fallback = "") {
    const explicit = cleanPlatform(fallback);
    if (explicit && explicit !== "unknown") return explicit;

    const ref = cleanLowerString(referrer);

    if (!ref) return "unknown";
    if (ref.includes("facebook.")) return "facebook";
    if (ref.includes("instagram.")) return "instagram";
    if (ref.includes("linkedin.")) return "linkedin";
    if (ref.includes("tiktok.")) return "tiktok";
    if (ref.includes("twitter.") || ref.includes("x.com")) return "x";
    if (ref.includes("google.")) return "google";

    return "other";
}

function pickTrackPayload(req) {
    const rawMeta =
        req.body?.meta &&
            typeof req.body.meta === "object" &&
            !Array.isArray(req.body.meta)
            ? req.body.meta
            : {};

    const pageUrl = cleanString(rawMeta.pageUrl || rawMeta.page_url).slice(0, 1200);
    const referrer = cleanString(rawMeta.referrer).slice(0, 1000);
    const actionTarget = cleanLowerString(rawMeta.actionTarget || rawMeta.action_target).slice(0, 120);
    const targetUrl = cleanString(rawMeta.targetUrl || rawMeta.target_url).slice(0, 1200);
    const visitorId = cleanString(rawMeta.visitorId || rawMeta.visitor_id).slice(0, 120);
    const sessionId = cleanString(rawMeta.sessionId || rawMeta.session_id).slice(0, 120);
    const visitId = cleanString(rawMeta.visitId || rawMeta.visit_id).slice(0, 120);

    const parsedPageUrl = parseUrlSafe(pageUrl);
    const utm_source = cleanLowerString(
        rawMeta.utm_source || parsedPageUrl?.searchParams?.get("utm_source") || ""
    ).slice(0, 120);
    const utm_medium = cleanLowerString(
        rawMeta.utm_medium || parsedPageUrl?.searchParams?.get("utm_medium") || ""
    ).slice(0, 120);
    const utm_campaign = cleanLowerString(
        rawMeta.utm_campaign || parsedPageUrl?.searchParams?.get("utm_campaign") || ""
    ).slice(0, 160);
    const utm_term = cleanString(
        rawMeta.utm_term || parsedPageUrl?.searchParams?.get("utm_term") || ""
    ).slice(0, 160);
    const utm_content = cleanString(
        rawMeta.utm_content || parsedPageUrl?.searchParams?.get("utm_content") || ""
    ).slice(0, 160);

    return {
        page_url: pageUrl,
        referrer,
        action_target: actionTarget,
        target_url: targetUrl,
        visitor_id: visitorId,
        session_id: sessionId,
        visit_id: visitId,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_term,
        utm_content,
    };
}

function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
}

function addDays(date, amount) {
    const d = new Date(date);
    d.setDate(d.getDate() + amount);
    return d;
}

function formatDayKey(date) {
    const d = new Date(date);
    const y = d.getFullYear();
    const m = `${d.getMonth() + 1}`.padStart(2, "0");
    const day = `${d.getDate()}`.padStart(2, "0");
    return `${y}-${m}-${day}`;
}

function getValidRangeDays(raw) {
    const value = Number(raw);
    if (value === 30) return 30;
    if (value === 90) return 90;
    return 7;
}

function isViewEventType(eventType) {
    return VIEW_EVENT_TYPES.includes(eventType);
}

function buildRecentDuplicateQuery({
    businessCard,
    eventType,
    sourceType,
    payload,
    ip,
    userAgent,
    since,
}) {
    const base = {
        owner_user: businessCard.user,
        business_card: businessCard._id,
        profile_slug: businessCard.profile_slug,
        event_type: eventType,
        source_type: sourceType,
        createdAt: { $gte: since },
    };

    if (payload.visit_id) {
        return {
            ...base,
            visit_id: payload.visit_id,
        };
    }

    if (payload.session_id) {
        return {
            ...base,
            session_id: payload.session_id,
        };
    }

    if (payload.visitor_id) {
        return {
            ...base,
            visitor_id: payload.visitor_id,
        };
    }

    return {
        ...base,
        ip,
        user_agent: userAgent,
    };
}

function buildTrafficSourcePipeline(match) {
    return [
        {
            $match: {
                ...match,
                event_type: { $in: VIEW_EVENT_TYPES },
            },
        },
        {
            $project: {
                source_type: 1,
                event_type: 1,
                canonical_source: {
                    $switch: {
                        branches: [
                            {
                                case: { $eq: ["$event_type", "qr_scan"] },
                                then: "qr",
                            },
                            {
                                case: { $eq: ["$event_type", "nfc_tap"] },
                                then: "nfc",
                            },
                            {
                                case: { $eq: ["$event_type", "link_open"] },
                                then: "link",
                            },
                            {
                                case: {
                                    $and: [
                                        { $eq: ["$event_type", "profile_view"] },
                                        {
                                            $in: [
                                                "$source_type",
                                                ["direct", "unknown"],
                                            ],
                                        },
                                    ],
                                },
                                then: "$source_type",
                            },
                        ],
                        default: null,
                    },
                },
            },
        },
        {
            $match: {
                canonical_source: { $in: ["direct", "link", "qr", "nfc", "unknown"] },
            },
        },
        {
            $group: {
                _id: "$canonical_source",
                count: { $sum: 1 },
            },
        },
        { $sort: { count: -1 } },
    ];
}

/**
 * POST /api/analytics/track
 * Public endpoint
 */
router.post("/track", async (req, res) => {
    try {
        const profileSlug = cleanSlug(req.body?.profileSlug);
        const eventType = cleanEventType(req.body?.eventType);
        const sourceType = cleanSourceType(req.body?.source);
        const payload = pickTrackPayload(req);

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

        const userAgent = cleanString(req.headers["user-agent"]).slice(0, 500);
        const ip = getClientIp(req);

        if (isViewEventType(eventType)) {
            const since = new Date(Date.now() - DEDUPE_WINDOW_MS);

            const duplicateQuery = buildRecentDuplicateQuery({
                businessCard,
                eventType,
                sourceType,
                payload,
                ip,
                userAgent,
                since,
            });

            const existingRecentEvent = await ProfileAnalyticsEvent.findOne(duplicateQuery)
                .select("_id createdAt")
                .lean();

            if (existingRecentEvent?._id) {
                return res.json({
                    ok: true,
                    deduped: true,
                });
            }
        }

        await ProfileAnalyticsEvent.create({
            owner_user: businessCard.user,
            business_card: businessCard._id,
            profile_slug: businessCard.profile_slug,
            event_type: eventType,
            source_type: sourceType,
            source_platform: detectPlatformFromReferrer(
                payload.referrer,
                req.body?.platform
            ),
            referrer: payload.referrer,
            utm_source: payload.utm_source,
            utm_medium: payload.utm_medium,
            utm_campaign: payload.utm_campaign,
            utm_term: payload.utm_term,
            utm_content: payload.utm_content,
            visitor_id: payload.visitor_id,
            session_id: payload.session_id,
            visit_id: payload.visit_id,
            action_target: payload.action_target,
            target_url: payload.target_url,
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

/**
 * GET /api/analytics/summary?days=7&profileSlug=slug
 * Protected endpoint for dashboard analytics
 */
router.get("/summary", requireAuth, async (req, res) => {
    try {
        const ownerUserId = req.user?._id || req.user?.id;
        if (!ownerUserId) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const days = getValidRangeDays(req.query?.days);
        const profileSlug = cleanSlug(req.query?.profileSlug);

        const endDate = new Date();
        const startDate = startOfDay(addDays(endDate, -(days - 1)));

        const match = {
            owner_user: ownerUserId,
            createdAt: { $gte: startDate, $lte: endDate },
        };

        if (profileSlug) {
            const ownedProfile = await BusinessCard.findOne({
                user: ownerUserId,
                profile_slug: profileSlug,
            })
                .select("_id profile_slug")
                .lean();

            if (!ownedProfile?._id) {
                return res.status(404).json({
                    error: "Profile not found",
                    code: "PROFILE_NOT_FOUND",
                });
            }

            match.profile_slug = ownedProfile.profile_slug;
        }

        const [metricsRows, sourceRows, platformRows, timelineRows] = await Promise.all([
            ProfileAnalyticsEvent.aggregate([
                { $match: match },
                {
                    $group: {
                        _id: null,
                        profileViews: {
                            $sum: {
                                $cond: [{ $eq: ["$event_type", "profile_view"] }, 1, 0],
                            },
                        },
                        qrScans: {
                            $sum: {
                                $cond: [{ $eq: ["$event_type", "qr_scan"] }, 1, 0],
                            },
                        },
                        cardTaps: {
                            $sum: {
                                $cond: [{ $eq: ["$event_type", "nfc_tap"] }, 1, 0],
                            },
                        },
                        linkOpens: {
                            $sum: {
                                $cond: [{ $eq: ["$event_type", "link_open"] }, 1, 0],
                            },
                        },
                        contactsSaved: {
                            $sum: {
                                $cond: [{ $eq: ["$event_type", "contact_save"] }, 1, 0],
                            },
                        },
                        contactExchangeOpens: {
                            $sum: {
                                $cond: [
                                    { $eq: ["$event_type", "contact_exchange_opened"] },
                                    1,
                                    0,
                                ],
                            },
                        },
                        contactExchangeSubmits: {
                            $sum: {
                                $cond: [{ $eq: ["$event_type", "contact_exchange"] }, 1, 0],
                            },
                        },
                        emailClicks: {
                            $sum: {
                                $cond: [{ $eq: ["$event_type", "email_clicked"] }, 1, 0],
                            },
                        },
                        phoneClicks: {
                            $sum: {
                                $cond: [{ $eq: ["$event_type", "phone_clicked"] }, 1, 0],
                            },
                        },
                        socialClicks: {
                            $sum: {
                                $cond: [{ $eq: ["$event_type", "social_clicked"] }, 1, 0],
                            },
                        },
                    },
                },
            ]),
            ProfileAnalyticsEvent.aggregate(buildTrafficSourcePipeline(match)),
            ProfileAnalyticsEvent.aggregate([
                {
                    $match: {
                        ...match,
                        event_type: "social_clicked",
                    },
                },
                {
                    $group: {
                        _id: "$source_platform",
                        count: { $sum: 1 },
                    },
                },
                { $sort: { count: -1 } },
            ]),
            ProfileAnalyticsEvent.aggregate([
                { $match: match },
                {
                    $group: {
                        _id: {
                            day: {
                                $dateToString: {
                                    format: "%Y-%m-%d",
                                    date: "$createdAt",
                                },
                            },
                        },
                        profileViews: {
                            $sum: {
                                $cond: [{ $eq: ["$event_type", "profile_view"] }, 1, 0],
                            },
                        },
                        qrScans: {
                            $sum: {
                                $cond: [{ $eq: ["$event_type", "qr_scan"] }, 1, 0],
                            },
                        },
                        cardTaps: {
                            $sum: {
                                $cond: [{ $eq: ["$event_type", "nfc_tap"] }, 1, 0],
                            },
                        },
                        contactsSaved: {
                            $sum: {
                                $cond: [{ $eq: ["$event_type", "contact_save"] }, 1, 0],
                            },
                        },
                    },
                },
                { $sort: { "_id.day": 1 } },
            ]),
        ]);

        const metrics = metricsRows[0] || {
            profileViews: 0,
            qrScans: 0,
            cardTaps: 0,
            linkOpens: 0,
            contactsSaved: 0,
            contactExchangeOpens: 0,
            contactExchangeSubmits: 0,
            emailClicks: 0,
            phoneClicks: 0,
            socialClicks: 0,
        };

        const timelineMap = new Map(
            timelineRows.map((row) => [
                row?._id?.day,
                {
                    profileViews: row.profileViews || 0,
                    qrScans: row.qrScans || 0,
                    cardTaps: row.cardTaps || 0,
                    contactsSaved: row.contactsSaved || 0,
                },
            ])
        );

        const timeline = [];
        for (let i = 0; i < days; i += 1) {
            const day = addDays(startDate, i);
            const key = formatDayKey(day);
            const row = timelineMap.get(key) || {
                profileViews: 0,
                qrScans: 0,
                cardTaps: 0,
                contactsSaved: 0,
            };

            timeline.push({
                date: key,
                label: day.toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: days > 30 ? "short" : undefined,
                }),
                profileViews: row.profileViews,
                qrScans: row.qrScans,
                cardTaps: row.cardTaps,
                contactsSaved: row.contactsSaved,
            });
        }

        const trafficSources = ["direct", "link", "qr", "nfc", "unknown"].map((key) => {
            const found = sourceRows.find((row) => row._id === key);
            return {
                key,
                label:
                    key === "qr"
                        ? "QR"
                        : key === "nfc"
                            ? "NFC"
                            : key.charAt(0).toUpperCase() + key.slice(1),
                value: found?.count || 0,
            };
        });

        const socialBreakdown = ["facebook", "instagram", "linkedin", "x", "tiktok", "google", "other"].map(
            (key) => {
                const found = platformRows.find((row) => row._id === key);
                return {
                    key,
                    label:
                        key === "x"
                            ? "X"
                            : key.charAt(0).toUpperCase() + key.slice(1),
                    value: found?.count || 0,
                };
            }
        );

        const totalConversions =
            (metrics.contactsSaved || 0) +
            (metrics.contactExchangeSubmits || 0) +
            (metrics.emailClicks || 0) +
            (metrics.phoneClicks || 0);

        const conversionRate =
            (metrics.profileViews || 0) > 0
                ? Number(((totalConversions / metrics.profileViews) * 100).toFixed(1))
                : 0;

        return res.json({
            ok: true,
            filters: {
                days,
                profileSlug: profileSlug || "all",
                startDate,
                endDate,
            },
            metrics: {
                ...metrics,
                totalConversions,
                conversionRate,
            },
            trafficSources,
            socialBreakdown,
            timeline,
        });
    } catch (err) {
        console.error("GET /api/analytics/summary error:", err);
        return res.status(500).json({
            error: "Failed to load analytics summary",
        });
    }
});

module.exports = router;