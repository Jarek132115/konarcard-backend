// backend/routes/checkout.js
const express = require("express");
const router = express.Router();

const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const QRCode = require("qrcode");

const { requireAuth } = require("../helpers/auth");
const User = require("../models/user");
const BusinessCard = require("../models/BusinessCard");
const NfcOrder = require("../models/NfcOrder");

const uploadToS3 = require("../utils/uploadToS3");

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const PUBLIC_PROFILE_DOMAIN =
    process.env.PUBLIC_PROFILE_DOMAIN || "https://www.konarcard.com";

const safeSlug = (v) =>
    String(v || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "");

const buildPublicProfileUrl = (profileSlug) => {
    const s = safeSlug(profileSlug);
    if (!s) return "";
    return `${PUBLIC_PROFILE_DOMAIN}/u/${s}`;
};

const buildTrackedProfileUrl = (profileSlug, via = "") => {
    const base = buildPublicProfileUrl(profileSlug);
    const cleanVia = String(via || "").trim().toLowerCase();

    if (!base) return "";
    if (!cleanVia) return base;

    const allowedVia = new Set(["qr", "nfc"]);
    if (!allowedVia.has(cleanVia)) return base;

    return `${base}?via=${encodeURIComponent(cleanVia)}`;
};

function buildFrontendReturnUrl(rawReturnUrl, fallbackPath = "/cards") {
    const fallback = `${FRONTEND_URL}${fallbackPath.startsWith("/") ? fallbackPath : `/${fallbackPath}`}`;

    if (!rawReturnUrl || typeof rawReturnUrl !== "string") {
        return fallback;
    }

    const trimmed = rawReturnUrl.trim();
    if (!trimmed) return fallback;

    try {
        if (/^https?:\/\//i.test(trimmed)) {
            const u = new URL(trimmed);

            const frontendOrigin = new URL(FRONTEND_URL).origin;
            if (u.origin !== frontendOrigin) return fallback;

            return u.toString();
        }

        if (trimmed.startsWith("/")) {
            return `${FRONTEND_URL}${trimmed}`;
        }

        return fallback;
    } catch {
        return fallback;
    }
}

function isWeekend(date) {
    const day = date.getDay();
    return day === 0 || day === 6;
}

function addWorkingDays(dateLike, daysToAdd) {
    const d = new Date(dateLike);
    d.setHours(12, 0, 0, 0);

    let added = 0;
    while (added < daysToAdd) {
        d.setDate(d.getDate() + 1);
        if (!isWeekend(d)) {
            added += 1;
        }
    }

    return d;
}

function formatEstimatedDeliveryDate(date) {
    return date.toLocaleDateString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
    });
}

function getInitialEstimatedDelivery(now = new Date()) {
    const beforeCutoff = now.getHours() < 13;

    const deliveryDate = beforeCutoff
        ? addWorkingDays(now, 1)
        : addWorkingDays(now, 2);

    return {
        label: formatEstimatedDeliveryDate(deliveryDate),
        helper: beforeCutoff
            ? "Same-day shipping when you order before 1pm."
            : "Orders after 1pm ship next working day.",
    };
}

// -------------------------
// Subscription helpers
// -------------------------
// IMPORTANT: Teams is NOT a standalone Stripe product.
// Teams = 1 × Plus Monthly + N × Extra Profile Monthly
// Always prefer the NEW_ prefixed price IDs (current pricing model)
// and fall back to legacy price IDs if NEW_ ones aren't set.
function getTeamsPriceId(interval = "monthly") {
    const i = String(interval || "monthly").toLowerCase();
    if (i === "monthly") {
        return (
            process.env.NEW_STRIPE_PRICE_PLUS_MONTHLY ||
            process.env.STRIPE_PRICE_TEAMS_MONTHLY
        );
    }
    if (i === "yearly") {
        return (
            process.env.NEW_STRIPE_PRICE_PLUS_YEARLY ||
            process.env.STRIPE_PRICE_TEAMS_YEARLY
        );
    }
    if (i === "quarterly") return process.env.STRIPE_PRICE_TEAMS_QUARTERLY;
    return (
        process.env.NEW_STRIPE_PRICE_PLUS_MONTHLY ||
        process.env.STRIPE_PRICE_TEAMS_MONTHLY
    );
}

function getExtraProfilePriceId(interval = "monthly") {
    const i = String(interval || "monthly").toLowerCase();
    if (i === "monthly") {
        return (
            process.env.NEW_STRIPE_PRICE_EXTRA_PROFILE_MONTHLY ||
            process.env.STRIPE_PRICE_EXTRA_PROFILE_MONTHLY
        );
    }
    if (i === "yearly") {
        return (
            process.env.NEW_STRIPE_PRICE_EXTRA_PROFILE_YEARLY ||
            process.env.STRIPE_PRICE_EXTRA_PROFILE_YEARLY
        );
    }
    if (i === "quarterly") return process.env.STRIPE_PRICE_EXTRA_PROFILE_QUARTERLY;
    return (
        process.env.NEW_STRIPE_PRICE_EXTRA_PROFILE_MONTHLY ||
        process.env.STRIPE_PRICE_EXTRA_PROFILE_MONTHLY
    );
}

const TEAMS_PRICE_IDS = [
    process.env.NEW_STRIPE_PRICE_PLUS_MONTHLY,
    process.env.NEW_STRIPE_PRICE_PLUS_YEARLY,
    process.env.STRIPE_PRICE_TEAMS_MONTHLY,
    process.env.STRIPE_PRICE_TEAMS_QUARTERLY,
    process.env.STRIPE_PRICE_TEAMS_YEARLY,
].filter(Boolean);

const EXTRA_PROFILE_PRICE_IDS = [
    process.env.NEW_STRIPE_PRICE_EXTRA_PROFILE_MONTHLY,
    process.env.NEW_STRIPE_PRICE_EXTRA_PROFILE_YEARLY,
    process.env.STRIPE_PRICE_EXTRA_PROFILE_MONTHLY,
    process.env.STRIPE_PRICE_EXTRA_PROFILE_QUARTERLY,
    process.env.STRIPE_PRICE_EXTRA_PROFILE_YEARLY,
].filter(Boolean);

async function ensureStripeCustomer(user) {
    if (user.stripeCustomerId) return user.stripeCustomerId;

    const customer = await stripe.customers.create({
        email: user.email,
        name: user.name || user.username || "",
        metadata: {
            userId: String(user._id),
            username: user.username || "",
        },
    });

    user.stripeCustomerId = customer.id;
    await user.save();
    return customer.id;
}

function isActiveStatus(status) {
    return status === "active" || status === "trialing";
}

function findSubItems(subscription) {
    const items = Array.isArray(subscription?.items?.data) ? subscription.items.data : [];

    const teamsItem = items.find((it) => {
        const pid = it?.price?.id;
        return pid && TEAMS_PRICE_IDS.includes(pid);
    });

    const extraItem = items.find((it) => {
        const pid = it?.price?.id;
        return pid && EXTRA_PROFILE_PRICE_IDS.includes(pid);
    });

    return { teamsItem, extraItem };
}

async function invoiceAndPayNow({ customerId, subscriptionId }) {
    const invoice = await stripe.invoices.create({
        customer: customerId,
        subscription: subscriptionId,
        collection_method: "charge_automatically",
        auto_advance: true,
    });

    const finalized = await stripe.invoices.finalizeInvoice(invoice.id);

    if (!finalized || !finalized.amount_due || finalized.amount_due <= 0) {
        return { paid: true, invoiceId: finalized?.id, amount_due: 0 };
    }

    const paid = await stripe.invoices.pay(finalized.id);
    return {
        paid: paid?.paid === true,
        invoiceId: paid?.id,
        amount_due: paid?.amount_due || 0,
    };
}

async function generateAndUploadProfileQr(userId, profileSlug) {
    const url = buildTrackedProfileUrl(profileSlug, "qr");
    if (!url) return "";

    const qrBuffer = await QRCode.toBuffer(url, {
        width: 900,
        margin: 2,
        errorCorrectionLevel: "M",
        color: { dark: "#000000", light: "#ffffff" },
    });

    const safe = safeSlug(profileSlug) || "profile";
    const fileKey = `qr-codes/${userId}/${safe}-${Date.now()}.png`;
    const qrCodeUrl = await uploadToS3(qrBuffer, fileKey);
    return qrCodeUrl;
}

async function createClaimedProfileForUser({
    user,
    claimedSlug,
    templateId = "template-1",
}) {
    const slug = safeSlug(claimedSlug);

    if (!slug || slug.length < 3) {
        const err = new Error("claimedSlug is required and must be at least 3 chars");
        err.statusCode = 400;
        err.code = "CLAIMED_SLUG_REQUIRED";
        throw err;
    }

    const existing = await BusinessCard.findOne({ profile_slug: slug });
    if (existing) {
        const err = new Error("Profile slug already exists");
        err.statusCode = 409;
        err.code = "SLUG_TAKEN";
        throw err;
    }

    const created = await BusinessCard.create({
        user: user._id,
        profile_slug: slug,
        template_id: templateId,
        business_card_name: "",
        business_name: "",
        trade_title: "",
        location: "",
        full_name: user.name || "",
        theme_mode: "light",
        page_theme: "light",
    });

    try {
        const qrUrl = await generateAndUploadProfileQr(user._id, slug);
        if (qrUrl) {
            created.qr_code_url = qrUrl;
            await created.save();

            if (!user.qrCodeUrl) {
                user.qrCodeUrl = qrUrl;
            }
            if (!user.profileUrl) {
                user.profileUrl = buildPublicProfileUrl(slug);
            }
            if (!user.slug) {
                user.slug = slug;
            }
            if (!user.username) {
                user.username = slug;
            }

            await user.save();
        }
    } catch (e) {
        console.error("QR generation failed (createClaimedProfileForUser):", e);
    }

    return created;
}

// -------------------------
// NFC product price mapping
// -------------------------
function getEnvAny(...keys) {
    for (const key of keys) {
        if (process.env[key]) return process.env[key];
    }
    return "";
}

const NFC_PRODUCT_CONFIG = {
    "plastic-white": {
        family: "plastic",
        edition: "plastic",
        variant: "white",
        priceId: getEnvAny("STRIPE_PRICE_PLASTIC_WHITE", "plastic-white"),
    },
    "plastic-black": {
        family: "plastic",
        edition: "plastic",
        variant: "black",
        priceId: getEnvAny("STRIPE_PRICE_PLASTIC_BLACK", "plastic-black"),
    },
    "plastic-blue": {
        family: "plastic",
        edition: "plastic",
        variant: "blue",
        priceId: getEnvAny("STRIPE_PRICE_PLASTIC_BLUE", "plastic-blue"),
    },
    "plastic-green": {
        family: "plastic",
        edition: "plastic",
        variant: "green",
        priceId: getEnvAny("STRIPE_PRICE_PLASTIC_GREEN", "plastic-green"),
    },
    "plastic-magenta": {
        family: "plastic",
        edition: "plastic",
        variant: "magenta",
        priceId: getEnvAny("STRIPE_PRICE_PLASTIC_MAGENTA", "plastic-magenta"),
    },
    "plastic-orange": {
        family: "plastic",
        edition: "plastic",
        variant: "orange",
        priceId: getEnvAny("STRIPE_PRICE_PLASTIC_ORANGE", "plastic-orange"),
    },
    "metal-card": {
        family: "metal",
        edition: "metal",
        variant: "gold",
        optionPriceMap: {
            black: getEnvAny("STRIPE_PRICE_METAL_BLACK", "metal-black"),
            gold: getEnvAny("STRIPE_PRICE_METAL_GOLD", "metal-gold"),
        },
    },
    konartag: {
        family: "tag",
        edition: "tag",
        variant: "black",
        optionPriceMap: {
            black: getEnvAny("STRIPE_PRICE_KONARTAG_BLACK", "konartag-black"),
            gold: getEnvAny("STRIPE_PRICE_KONARTAG_GOLD", "konartag-gold"),
        },
    },
};

function normalizeProductKey(v) {
    const s = String(v || "").trim().toLowerCase();

    if (s === "plastic" || s === "plastic-card" || s === "konarcard-plastic") return "plastic-white";
    if (s === "plastic-white") return "plastic-white";
    if (s === "plastic-black") return "plastic-black";
    if (s === "plastic-blue") return "plastic-blue";
    if (s === "plastic-green") return "plastic-green";
    if (s === "plastic-magenta") return "plastic-magenta";
    if (s === "plastic-orange") return "plastic-orange";

    if (s === "metal" || s === "metal-card" || s === "konarcard-metal") return "metal-card";
    if (s === "konartag" || s === "tag") return "konartag";

    return s;
}

function normalizeVariantForProduct(productKey, rawVariant) {
    const variant = String(rawVariant || "").trim().toLowerCase();

    if (!variant) {
        return NFC_PRODUCT_CONFIG?.[productKey]?.variant || "";
    }

    if (productKey === "konartag" && variant === "white") {
        return "gold";
    }

    return variant;
}

function decodeDataUrlToBuffer(dataUrl) {
    const str = String(dataUrl || "");
    const m = str.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return null;

    const mime = String(m[1] || "").trim().toLowerCase();
    const b64 = String(m[2] || "").trim();
    if (!mime || !b64) return null;

    let buf;
    try {
        buf = Buffer.from(b64, "base64");
    } catch {
        return null;
    }

    if (!buf || !buf.length) return null;

    return { mime, buf };
}

async function uploadBufferToS3({ buffer, key, mime }) {
    try {
        return await uploadToS3(buffer, key, mime);
    } catch {
        return await uploadToS3(buffer, key);
    }
}

// ----------------------------------------------------
// POST /api/checkout/teams
// ----------------------------------------------------
router.post("/teams", requireAuth, async (req, res) => {
    try {
        const userId = req.user?._id;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const user = await User.findById(userId);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const interval = String(req.body?.interval || "monthly").toLowerCase();

        const desiredProfiles = Math.max(
            2,
            Number(req.body?.desiredProfiles || req.body?.desiredQuantity || req.body?.quantity || 2)
        );

        const extraProfilesQty = Math.max(1, desiredProfiles - 1);

        const claimedSlugRaw = req.body?.claimedSlug || req.body?.profile_slug || "";
        const claimedSlug = safeSlug(claimedSlugRaw);

        if (!claimedSlug || claimedSlug.length < 3) {
            return res.status(400).json({
                error: "claimedSlug is required and must be at least 3 chars",
                code: "CLAIMED_SLUG_REQUIRED",
            });
        }

        const exists = await BusinessCard.findOne({ profile_slug: claimedSlug }).select("_id");
        if (exists) {
            return res.status(409).json({
                error: "Profile slug already exists",
                code: "SLUG_TAKEN",
            });
        }

        const teamsPriceId = getTeamsPriceId(interval);
        const extraPriceId = getExtraProfilePriceId(interval);

        if (!teamsPriceId) {
            return res.status(500).json({
                error: "Teams price ID missing in env",
                code: "MISSING_TEAMS_PRICE_ID",
            });
        }

        if (!extraPriceId) {
            return res.status(500).json({
                error: "Extra profile price ID missing in env",
                code: "MISSING_EXTRA_PROFILE_PRICE_ID",
            });
        }

        const stripeCustomerId = await ensureStripeCustomer(user);

        if (String(user.plan || "").toLowerCase() === "teams" && user.stripeSubscriptionId) {
            const sub = await stripe.subscriptions.retrieve(user.stripeSubscriptionId, {
                expand: ["items.data.price"],
            });

            if (sub && isActiveStatus(sub.status)) {
                const { teamsItem, extraItem } = findSubItems(sub);

                if (!teamsItem) {
                    return res.status(500).json({
                        error: "Could not find Teams item on subscription. Check Stripe prices mapping.",
                        code: "TEAMS_ITEM_NOT_FOUND",
                    });
                }

                const items = [{ id: teamsItem.id, quantity: 1 }];

                if (extraItem) items.push({ id: extraItem.id, quantity: extraProfilesQty });
                else items.push({ price: extraPriceId, quantity: extraProfilesQty });

                await stripe.subscriptions.update(sub.id, {
                    items,
                    proration_behavior: "create_prorations",
                });

                let prorationResult = { paid: false };
                try {
                    prorationResult = await invoiceAndPayNow({
                        customerId: stripeCustomerId,
                        subscriptionId: sub.id,
                    });
                } catch (e) {
                    console.error("Proration invoice/pay failed:", e?.message || e);
                    prorationResult = { paid: false, error: "proration_charge_failed" };
                }

                const createdProfile = await createClaimedProfileForUser({
                    user,
                    claimedSlug,
                    templateId: "template-1",
                });

                user.plan = "teams";
                user.subscriptionStatus = sub.status || user.subscriptionStatus || "active";
                user.extraProfilesQty = extraProfilesQty;
                user.teamsProfilesQty = 1 + extraProfilesQty;
                await user.save();

                return res.json({
                    updated: true,
                    created: true,
                    mode: "subscription_update",
                    desiredProfiles,
                    extraProfilesQty,
                    profile: createdProfile,
                    proration: prorationResult,
                });
            }
        }

        const successUrl =
            `${FRONTEND_URL}/profiles?checkout=success` +
            `&slug=${encodeURIComponent(claimedSlug)}` +
            `&profiles=${encodeURIComponent(String(desiredProfiles))}` +
            `&session_id={CHECKOUT_SESSION_ID}`;

        const cancelUrl = `${FRONTEND_URL}/profiles?checkout=cancel`;

        const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            customer: stripeCustomerId,
            payment_method_types: ["card"],

            client_reference_id: String(user._id),

            line_items: [
                { price: teamsPriceId, quantity: 1 },
                { price: extraPriceId, quantity: extraProfilesQty },
            ],

            metadata: {
                userId: String(user._id),
                planKey: `teams-${interval}`,
                claimedSlug,
                desiredProfiles: String(desiredProfiles),
                extraProfilesQty: String(extraProfilesQty),
                checkoutType: "teams_add_profile",
            },

            subscription_data: {
                metadata: {
                    userId: String(user._id),
                    planKey: `teams-${interval}`,
                    claimedSlug,
                    desiredProfiles: String(desiredProfiles),
                    extraProfilesQty: String(extraProfilesQty),
                    checkoutType: "teams_add_profile",
                },
            },

            success_url: successUrl,
            cancel_url: cancelUrl,
            allow_promotion_codes: true,
        });

        return res.json({ url: session.url, id: session.id });
    } catch (err) {
        console.error("Teams checkout error:", err);

        const statusCode = Number(err?.statusCode || 500);
        const code = err?.code || undefined;
        const message = err?.message || "Stripe checkout session failed";

        return res.status(statusCode).json({
            error: message,
            ...(code ? { code } : {}),
        });
    }
});

// ----------------------------------------------------
// Upload logo (base64 data URL -> S3)
// POST /api/checkout/nfc/logo
// Body: { dataUrl, filename? }
// ----------------------------------------------------
router.post("/nfc/logo", requireAuth, async (req, res) => {
    try {
        const userId = req.user?._id;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const { dataUrl, filename } = req.body || {};
        const decoded = decodeDataUrlToBuffer(dataUrl);

        if (!decoded?.buf || !decoded?.mime) {
            return res.status(400).json({ error: "Invalid dataUrl", code: "INVALID_DATA_URL" });
        }

        if (!decoded.mime.startsWith("image/")) {
            return res.status(400).json({ error: "Only image uploads allowed", code: "INVALID_MIME" });
        }

        if (decoded.buf.length > 3 * 1024 * 1024) {
            return res.status(400).json({ error: "Logo too large (max 3MB)", code: "LOGO_TOO_LARGE" });
        }

        const ext =
            decoded.mime === "image/png"
                ? "png"
                : decoded.mime === "image/jpeg"
                    ? "jpg"
                    : decoded.mime === "image/webp"
                        ? "webp"
                        : "png";

        const safeName = String(filename || `logo.${ext}`)
            .trim()
            .replace(/[^a-zA-Z0-9._-]/g, "")
            .slice(0, 80);

        const key = `nfc-logos/${String(userId)}/${Date.now()}-${safeName || `logo.${ext}`}`;
        const url = await uploadBufferToS3({ buffer: decoded.buf, key, mime: decoded.mime });

        return res.json({ ok: true, logoUrl: url, key });
    } catch (err) {
        console.error("nfc/logo upload error:", err);
        return res.status(500).json({ error: "Failed to upload logo" });
    }
});

// ----------------------------------------------------
// Upload preview image (product + logo) (base64 data URL -> S3)
// POST /api/checkout/nfc/preview
// Body: { dataUrl, filename?, productKey?, variant? }
// ----------------------------------------------------
router.post("/nfc/preview", requireAuth, async (req, res) => {
    try {
        const userId = req.user?._id;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const { dataUrl, filename, productKey, variant } = req.body || {};
        const decoded = decodeDataUrlToBuffer(dataUrl);

        if (!decoded?.buf || !decoded?.mime) {
            return res.status(400).json({ error: "Invalid dataUrl", code: "INVALID_DATA_URL" });
        }

        if (!decoded.mime.startsWith("image/")) {
            return res.status(400).json({ error: "Only image uploads allowed", code: "INVALID_MIME" });
        }

        if (decoded.buf.length > 6 * 1024 * 1024) {
            return res.status(400).json({ error: "Preview too large (max 6MB)", code: "PREVIEW_TOO_LARGE" });
        }

        const ext =
            decoded.mime === "image/png"
                ? "png"
                : decoded.mime === "image/jpeg"
                    ? "jpg"
                    : decoded.mime === "image/webp"
                        ? "webp"
                        : "png";

        const safeFile = String(filename || `preview.${ext}`)
            .trim()
            .replace(/[^a-zA-Z0-9._-]/g, "")
            .slice(0, 80);

        const pk = normalizeProductKey(productKey);
        const v = normalizeVariantForProduct(pk, variant);

        const key = `nfc-previews/${String(userId)}/${pk || "product"}/${v || "variant"}/${Date.now()}-${safeFile || `preview.${ext}`}`;
        const url = await uploadBufferToS3({ buffer: decoded.buf, key, mime: decoded.mime });

        return res.json({ ok: true, previewImageUrl: url, key });
    } catch (err) {
        console.error("nfc/preview upload error:", err);
        return res.status(500).json({ error: "Failed to upload preview image" });
    }
});

// ----------------------------------------------------
// Create NFC checkout session (one-time payment)
// POST /api/checkout/nfc/session
// Body:
// {
//   productKey,
//   variant?,
//   quantity,
//   profileId,
//   logoUrl?,
//   previewImageUrl?,
//   preview?,
//   customization?,
//   returnUrl?
// }
// ----------------------------------------------------
router.post("/nfc/session", requireAuth, async (req, res) => {
    try {
        const userId = req.user?._id;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const user = await User.findById(userId);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const productKey = normalizeProductKey(req.body?.productKey);
        const config = NFC_PRODUCT_CONFIG[productKey];

        if (!config) {
            return res.status(400).json({
                error: "Invalid product",
                code: "INVALID_NFC_PRODUCT",
                productKey,
            });
        }

        const variant = normalizeVariantForProduct(productKey, req.body?.variant);
        let priceId = "";
        let resolvedVariant = variant || config.variant || "";

        if (config.optionPriceMap) {
            const allowedVariants = Object.keys(config.optionPriceMap);
            if (!allowedVariants.includes(resolvedVariant)) {
                return res.status(400).json({
                    error: "Invalid variant",
                    code: "INVALID_NFC_VARIANT",
                    productKey,
                    variant: resolvedVariant,
                    allowedVariants,
                });
            }

            priceId = config.optionPriceMap[resolvedVariant];
        } else {
            resolvedVariant = config.variant || resolvedVariant;
            priceId = config.priceId;
        }

        if (!priceId) {
            return res.status(500).json({
                error: "Stripe price ID missing in env for this product",
                code: "MISSING_NFC_PRICE_ID",
                productKey,
                variant: resolvedVariant,
            });
        }

        const quantity = Math.max(1, Math.min(50, Number(req.body?.quantity || 1)));

        const profileId = String(req.body?.profileId || "").trim();
        if (!profileId) {
            return res.status(400).json({ error: "profileId is required", code: "PROFILE_REQUIRED" });
        }

        const profile = await BusinessCard.findOne({ _id: profileId, user: user._id })
            .select("_id profile_slug qr_code_url")
            .lean();

        if (!profile) {
            return res.status(403).json({ error: "Invalid profile selection", code: "INVALID_PROFILE" });
        }

        const profileSlug = safeSlug(profile.profile_slug);
        const publicProfileUrl = buildPublicProfileUrl(profileSlug);
        const qrTargetUrl = buildTrackedProfileUrl(profileSlug, "qr");
        const nfcTargetUrl = buildTrackedProfileUrl(profileSlug, "nfc");
        const qrCodeUrl = String(profile?.qr_code_url || "").trim();

        const logoUrl = String(req.body?.logoUrl || "").trim();
        const previewImageUrl = String(req.body?.previewImageUrl || "").trim();

        const preview =
            req.body?.preview && typeof req.body.preview === "object" ? req.body.preview : {};

        const customization =
            req.body?.customization && typeof req.body.customization === "object"
                ? req.body.customization
                : {};

        const frontText = String(customization.frontText || "").trim();
        const fontFamily = String(customization.fontFamily || "").trim();
        const fontWeight = Number(customization.fontWeight || 0);
        const fontSize = Number(customization.fontSize || 0);
        const orientation = String(customization.orientation || "").trim();
        const textColor = String(customization.textColor || "").trim();

        const cleanCustomization = {
            ...(frontText ? { frontText } : {}),
            ...(fontFamily ? { fontFamily } : {}),
            ...(Number.isFinite(fontWeight) && fontWeight > 0 ? { fontWeight } : {}),
            ...(Number.isFinite(fontSize) && fontSize > 0 ? { fontSize } : {}),
            ...(orientation ? { orientation } : {}),
            ...(textColor ? { textColor } : {}),
        };

        const cleanPreview = {
            ...(preview && typeof preview === "object" ? preview : {}),
            variant: resolvedVariant,
            family: config.family,
            edition: config.edition,
            profileSlug,
            publicProfileUrl,
            qrTargetUrl,
            nfcTargetUrl,
            ...(Object.keys(cleanCustomization).length ? { customization: cleanCustomization } : {}),
        };

        const returnBaseUrl = buildFrontendReturnUrl(req.body?.returnUrl, "/cards");
        const stripeCustomerId = await ensureStripeCustomer(user);
        const estimatedDelivery = getInitialEstimatedDelivery();

        const order = await NfcOrder.create({
            user: user._id,
            profile: profile._id,
            productKey,
            variant: resolvedVariant,
            quantity,
            logoUrl,
            previewImageUrl,
            qrCodeUrl,
            publicProfileUrl,
            qrTargetUrl,
            nfcTargetUrl,
            preview: cleanPreview,
            currency: "gbp",
            status: "pending",
            stripeCustomerId,
            deliveryWindow: estimatedDelivery.label,
        });

        const successUrl =
            `${returnBaseUrl}${returnBaseUrl.includes("?") ? "&" : "?"}` +
            `checkout=success` +
            `&order=${encodeURIComponent(String(order._id))}` +
            `&product=${encodeURIComponent(productKey)}` +
            `&session_id={CHECKOUT_SESSION_ID}`;

        const cancelUrl =
            `${returnBaseUrl}${returnBaseUrl.includes("?") ? "&" : "?"}` +
            `checkout=cancel` +
            `&order=${encodeURIComponent(String(order._id))}` +
            `&product=${encodeURIComponent(productKey)}`;

        console.log("NFC checkout debug:", {
            productKey,
            resolvedVariant,
            priceId,
            quantity,
            profileId,
            configFamily: config.family,
            configEdition: config.edition,
            publicProfileUrl,
            qrTargetUrl,
            nfcTargetUrl,
            deliveryWindow: estimatedDelivery.label,
        });

        const session = await stripe.checkout.sessions.create({
            mode: "payment",
            customer: stripeCustomerId,
            payment_method_types: ["card"],
            allow_promotion_codes: true,

            billing_address_collection: "required",
            shipping_address_collection: {
                allowed_countries: ["GB"],
            },

            line_items: [{ price: priceId, quantity }],

            client_reference_id: String(user._id),

            metadata: {
                checkoutType: "nfc_order",
                userId: String(user._id),
                orderId: String(order._id),
                productKey,
                variant: resolvedVariant,
                family: config.family,
                edition: config.edition,
                quantity: String(quantity),
                profileId: String(profile._id),
                profileSlug,
                publicProfileUrl: publicProfileUrl || "",
                qrTargetUrl: qrTargetUrl || "",
                nfcTargetUrl: nfcTargetUrl || "",
                logoUrl: logoUrl || "",
                previewImageUrl: previewImageUrl || "",
                returnUrl: returnBaseUrl,
                deliveryWindow: estimatedDelivery.label,

                frontText: frontText || "",
                fontFamily: fontFamily || "",
                fontWeight: Number.isFinite(fontWeight) && fontWeight > 0 ? String(fontWeight) : "",
                fontSize: Number.isFinite(fontSize) && fontSize > 0 ? String(fontSize) : "",
                orientation: orientation || "",
                textColor: textColor || "",

                styleKey: String(preview?.styleKey || ""),
                frontTemplate: String(preview?.frontTemplate || ""),
                backTemplate: String(preview?.backTemplate || ""),
                usesPresetArtwork: preview?.usesPresetArtwork ? "true" : "false",
            },

            success_url: successUrl,
            cancel_url: cancelUrl,
        });

        order.stripeCheckoutSessionId = session.id;
        await order.save();

        return res.json({
            url: session.url,
            orderId: String(order._id),
            profileSlug,
            publicProfileUrl,
            qrTargetUrl,
            nfcTargetUrl,
            deliveryWindow: estimatedDelivery.label,
        });
    } catch (err) {
        console.error("nfc/session error:", err);
        return res.status(500).json({
            error: "Failed to start NFC checkout",
            details: err?.message || String(err),
        });
    }
});

module.exports = router;