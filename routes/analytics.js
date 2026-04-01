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

const VIEW_EVENT_TYPES = ["qr_scan", "nfc_tap", "link_open"];
const CONVERSION_EVENT_TYPES = ["contact_save", "contact_exchange"];
const RECENT_ACTIVITY_EVENT_TYPES = [
    "qr_scan",
    "nfc_tap",
    "link_open",
    "contact_save",
    "contact_exchange",
    "contact_exchange_opened",
    "email_clicked",
    "phone_clicked",
    "social_clicked",
];

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

    if (value === 1) return 1;
    if (value === 2) return 2;
    if (value === 7) return 7;
    if (value === 14) return 14;
    if (value === 30) return 30;
    if (value === 60) return 60;
    if (value === 90) return 90;
    if (value === 120) return 120;
    if (value === 180) return 180;
    if (value === 365) return 365;
    if (value === 730) return 730;

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
                canonical_source: {
                    $switch: {
                        branches: [
                            {
                                case: { $eq: ["$event_type", "link_open"] },
                                then: "link",
                            },
                            {
                                case: { $eq: ["$event_type", "qr_scan"] },
                                then: "qr",
                            },
                            {
                                case: { $eq: ["$event_type", "nfc_tap"] },
                                then: "nfc",
                            },
                        ],
                        default: "unknown",
                    },
                },
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

function buildIdentityExpr() {
    return {
        $switch: {
            branches: [
                {
                    case: {
                        $gt: [{ $strLenCP: { $ifNull: ["$visit_id", ""] } }, 0],
                    },
                    then: { $concat: ["visit:", "$visit_id"] },
                },
                {
                    case: {
                        $gt: [{ $strLenCP: { $ifNull: ["$session_id", ""] } }, 0],
                    },
                    then: { $concat: ["session:", "$session_id"] },
                },
                {
                    case: {
                        $gt: [{ $strLenCP: { $ifNull: ["$visitor_id", ""] } }, 0],
                    },
                    then: { $concat: ["visitor:", "$visitor_id"] },
                },
                {
                    case: {
                        $or: [
                            { $gt: [{ $strLenCP: { $ifNull: ["$ip", ""] } }, 0] },
                            { $gt: [{ $strLenCP: { $ifNull: ["$user_agent", ""] } }, 0] },
                        ],
                    },
                    then: {
                        $concat: [
                            "anon:",
                            { $ifNull: ["$ip", ""] },
                            "|",
                            { $ifNull: ["$user_agent", ""] },
                        ],
                    },
                },
            ],
            default: "unknown-visitor",
        },
    };
}

function buildUniqueCountPipeline(match, eventTypes) {
    return [
        {
            $match: {
                ...match,
                event_type: { $in: eventTypes },
            },
        },
        {
            $project: {
                identity_key: buildIdentityExpr(),
            },
        },
        {
            $group: {
                _id: "$identity_key",
            },
        },
        {
            $count: "count",
        },
    ];
}

function buildDailyUniqueConversionPipeline(match) {
    return [
        {
            $match: {
                ...match,
                event_type: { $in: CONVERSION_EVENT_TYPES },
            },
        },
        {
            $project: {
                day: {
                    $dateToString: {
                        format: "%Y-%m-%d",
                        date: "$createdAt",
                    },
                },
                identity_key: buildIdentityExpr(),
            },
        },
        {
            $group: {
                _id: {
                    day: "$day",
                    identity_key: "$identity_key",
                },
            },
        },
        {
            $group: {
                _id: "$_id.day",
                contactConversions: { $sum: 1 },
            },
        },
        { $sort: { _id: 1 } },
    ];
}

function buildTimelinePipeline(match) {
    return [
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
                        $cond: [{ $in: ["$event_type", VIEW_EVENT_TYPES] }, 1, 0],
                    },
                },
                linkOpens: {
                    $sum: {
                        $cond: [{ $eq: ["$event_type", "link_open"] }, 1, 0],
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
        { $sort: { "_id.day": 1 } },
    ];
}

function buildRecentActivityPipeline(match, limit = 10) {
    return [
        {
            $match: {
                ...match,
                event_type: { $in: RECENT_ACTIVITY_EVENT_TYPES },
            },
        },
        { $sort: { createdAt: -1, _id: -1 } },
        { $limit: limit },
        {
            $project: {
                _id: 1,
                event_type: 1,
                source_type: 1,
                source_platform: 1,
                profile_slug: 1,
                action_target: 1,
                target_url: 1,
                createdAt: 1,
            },
        },
    ];
}

function getRecentActivityMessage(event) {
    const eventType = cleanLowerString(event?.event_type);
    const actionTarget = cleanLowerString(event?.action_target);
    const sourcePlatform = cleanLowerString(event?.source_platform);

    switch (eventType) {
        case "qr_scan":
            return "Someone scanned your QR code";
        case "nfc_tap":
            return "Someone tapped your NFC card";
        case "link_open":
            return "Someone clicked your link";
        case "contact_save":
            return "Someone saved your number";
        case "contact_exchange":
            return "Someone exchanged contacts with you";
        case "contact_exchange_opened":
            return "Someone opened your contact exchange form";
        case "email_clicked":
            return "Someone clicked your email";
        case "phone_clicked":
            return "Someone clicked your phone number";
        case "social_clicked": {
            const socialName =
                actionTarget === "facebook_url" || sourcePlatform === "facebook"
                    ? "Facebook"
                    : actionTarget === "instagram_url" || sourcePlatform === "instagram"
                        ? "Instagram"
                        : actionTarget === "linkedin_url" || sourcePlatform === "linkedin"
                            ? "LinkedIn"
                            : actionTarget === "x_url" ||
                                actionTarget === "twitter_url" ||
                                sourcePlatform === "x"
                                ? "X"
                                : actionTarget === "tiktok_url" || sourcePlatform === "tiktok"
                                    ? "TikTok"
                                    : "social";

            return socialName === "social"
                ? "Someone clicked one of your social links"
                : `Someone clicked your ${socialName} profile`;
        }
        default:
            return "New activity on your profile";
    }
}

function normalizeRecentActivity(rows) {
    return rows.map((row) => ({
        id: row?._id?.toString?.() || String(row?._id || ""),
        event_type: row?.event_type || "",
        source_type: row?.source_type || "unknown",
        source_platform: row?.source_platform || "unknown",
        profile_slug: row?.profile_slug || "",
        action_target: row?.action_target || "",
        target_url: row?.target_url || "",
        createdAt: row?.createdAt || null,
        message: getRecentActivityMessage(row),
    }));
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

        const [
            metricsRows,
            sourceRows,
            platformRows,
            timelineRows,
            dailyUniqueConversionRows,
            uniqueVisitorRows,
            uniqueConverterRows,
            recentActivityRows,
        ] = await Promise.all([
            ProfileAnalyticsEvent.aggregate([
                { $match: match },
                {
                    $group: {
                        _id: null,
                        profileViews: {
                            $sum: {
                                $cond: [{ $in: ["$event_type", VIEW_EVENT_TYPES] }, 1, 0],
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
            ProfileAnalyticsEvent.aggregate(buildTimelinePipeline(match)),
            ProfileAnalyticsEvent.aggregate(buildDailyUniqueConversionPipeline(match)),
            ProfileAnalyticsEvent.aggregate(
                buildUniqueCountPipeline(match, VIEW_EVENT_TYPES)
            ),
            ProfileAnalyticsEvent.aggregate(
                buildUniqueCountPipeline(match, CONVERSION_EVENT_TYPES)
            ),
            ProfileAnalyticsEvent.aggregate(buildRecentActivityPipeline(match, 10)),
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

        const uniqueVisitors = uniqueVisitorRows[0]?.count || 0;
        const contactConversions = uniqueConverterRows[0]?.count || 0;

        const dailyUniqueConversionMap = new Map(
            dailyUniqueConversionRows.map((row) => [
                row?._id,
                row?.contactConversions || 0,
            ])
        );

        const timelineMap = new Map(
            timelineRows.map((row) => [
                row?._id?.day,
                {
                    profileViews: row.profileViews || 0,
                    linkOpens: row.linkOpens || 0,
                    qrScans: row.qrScans || 0,
                    cardTaps: row.cardTaps || 0,
                    contactsSaved: row.contactsSaved || 0,
                    contactExchangeSubmits: row.contactExchangeSubmits || 0,
                    emailClicks: row.emailClicks || 0,
                    phoneClicks: row.phoneClicks || 0,
                    socialClicks: row.socialClicks || 0,
                },
            ])
        );

        const timeline = [];
        for (let i = 0; i < days; i += 1) {
            const day = addDays(startDate, i);
            const key = formatDayKey(day);
            const row = timelineMap.get(key) || {
                profileViews: 0,
                linkOpens: 0,
                qrScans: 0,
                cardTaps: 0,
                contactsSaved: 0,
                contactExchangeSubmits: 0,
                emailClicks: 0,
                phoneClicks: 0,
                socialClicks: 0,
            };

            timeline.push({
                date: key,
                label: day.toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: days > 30 ? "short" : undefined,
                }),
                profileViews: row.profileViews,
                linkOpens: row.linkOpens,
                qrScans: row.qrScans,
                cardTaps: row.cardTaps,
                contactsSaved: row.contactsSaved,
                contactExchangeSubmits: row.contactExchangeSubmits,
                emailClicks: row.emailClicks,
                phoneClicks: row.phoneClicks,
                socialClicks: row.socialClicks,
                contactConversions: dailyUniqueConversionMap.get(key) || 0,
            });
        }

        const trafficSources = ["link", "qr", "nfc", "unknown"].map((key) => {
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

        const socialBreakdown = [
            "facebook",
            "instagram",
            "linkedin",
            "x",
            "tiktok",
            "google",
            "other",
        ].map((key) => {
            const found = platformRows.find((row) => row._id === key);
            return {
                key,
                label:
                    key === "x"
                        ? "X"
                        : key.charAt(0).toUpperCase() + key.slice(1),
                value: found?.count || 0,
            };
        });

        const conversionRate =
            uniqueVisitors > 0
                ? Number(((contactConversions / uniqueVisitors) * 100).toFixed(1))
                : 0;

        const recentActivity = normalizeRecentActivity(recentActivityRows || []);

        return res.json({
            ok: true,
            filters: {
                days,
                profileSlug: profileSlug || "all",
                startDate,
                endDate,
            },
            metrics: {
                profileViews: metrics.profileViews || 0,
                linkOpens: metrics.linkOpens || 0,
                cardTaps: metrics.cardTaps || 0,
                qrScans: metrics.qrScans || 0,
                contactsSaved: metrics.contactsSaved || 0,
                contactExchangeOpens: metrics.contactExchangeOpens || 0,
                contactExchangeSubmits: metrics.contactExchangeSubmits || 0,
                emailClicks: metrics.emailClicks || 0,
                phoneClicks: metrics.phoneClicks || 0,
                socialClicks: metrics.socialClicks || 0,
                uniqueVisitors,
                contactConversions,
                totalConversions: contactConversions,
                conversionRate,
            },
            trafficSources,
            socialBreakdown,
            timeline,
            recentActivity,
        });
    } catch (err) {
        console.error("GET /api/analytics/summary error:", err);
        return res.status(500).json({
            error: "Failed to load analytics summary",
        });
    }
});

module.exports = router;