const express = require("express");
const router = express.Router();

const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const { requireAuth } = require("../helpers/auth");
const User = require("../models/user");
const BusinessCard = require("../models/BusinessCard");
const NfcOrder = require("../models/NfcOrder");

const uploadToS3 = require("../utils/uploadToS3");

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

const safeSlug = (v) =>
    String(v || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "");

// -------------------------
// Subscription helpers (EXISTING)
// -------------------------
function getTeamsPriceId(interval = "monthly") {
    const i = String(interval || "monthly").toLowerCase();
    if (i === "monthly") return process.env.STRIPE_PRICE_TEAMS_MONTHLY;
    if (i === "quarterly") return process.env.STRIPE_PRICE_TEAMS_QUARTERLY;
    if (i === "yearly") return process.env.STRIPE_PRICE_TEAMS_YEARLY;
    return process.env.STRIPE_PRICE_TEAMS_MONTHLY;
}

function getExtraProfilePriceId(interval = "monthly") {
    const i = String(interval || "monthly").toLowerCase();
    if (i === "monthly") return process.env.STRIPE_PRICE_EXTRA_PROFILE_MONTHLY;
    if (i === "quarterly") return process.env.STRIPE_PRICE_EXTRA_PROFILE_QUARTERLY;
    if (i === "yearly") return process.env.STRIPE_PRICE_EXTRA_PROFILE_YEARLY;
    return process.env.STRIPE_PRICE_EXTRA_PROFILE_MONTHLY;
}

const TEAMS_PRICE_IDS = [
    process.env.STRIPE_PRICE_TEAMS_MONTHLY,
    process.env.STRIPE_PRICE_TEAMS_QUARTERLY,
    process.env.STRIPE_PRICE_TEAMS_YEARLY,
].filter(Boolean);

const EXTRA_PROFILE_PRICE_IDS = [
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
    return { paid: paid?.paid === true, invoiceId: paid?.id, amount_due: paid?.amount_due || 0 };
}

// -------------------------
// NEW: NFC product price mapping
// -------------------------
// Set these in env:
// STRIPE_PRICE_PLASTIC_CARD
// STRIPE_PRICE_METAL_CARD
// STRIPE_PRICE_KONARTAG
const NFC_PRICE_MAP = {
    "plastic-card": {
        white: process.env.STRIPE_PRICE_PLASTIC_WHITE,
        black: process.env.STRIPE_PRICE_PLASTIC_BLACK,
    },
    "metal-card": {
        black: process.env.STRIPE_PRICE_METAL_BLACK,
        gold: process.env.STRIPE_PRICE_METAL_GOLD,
    },
    "konartag": {
        black: process.env.STRIPE_PRICE_KONARTAG_BLACK,
        white: process.env.STRIPE_PRICE_KONARTAG_WHITE,
    },
};


function normalizeProductKey(v) {
    const s = String(v || "").trim().toLowerCase();
    if (s === "plastic" || s === "plastic-card" || s === "konarcard-plastic") return "plastic-card";
    if (s === "metal" || s === "metal-card" || s === "konarcard-metal") return "metal-card";
    if (s === "konartag" || s === "tag") return "konartag";
    return s;
}

function decodeDataUrlToBuffer(dataUrl) {
    // data:image/png;base64,AAAA
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

// ----------------------------------------------------
// ✅ EXISTING: /api/checkout/teams (UNCHANGED)
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

        if (user.plan === "teams" && user.stripeSubscriptionId) {
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

                return res.json({
                    updated: true,
                    mode: "subscription_update",
                    desiredProfiles,
                    extraProfilesQty,
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
        return res.status(500).json({ error: "Stripe checkout session failed" });
    }
});

// ----------------------------------------------------
// ✅ NEW: Upload logo (base64 data URL -> S3)
// POST /api/checkout/nfc/logo
// Body: { dataUrl: "data:image/png;base64,...", filename?: "logo.png" }
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

        // Size guard (~3MB)
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

        // ✅ compatible with both signatures:
        // uploadToS3(buffer, key) OR uploadToS3(buffer, key, mime)
        let url;
        try {
            url = await uploadToS3(decoded.buf, key, decoded.mime);
        } catch {
            url = await uploadToS3(decoded.buf, key);
        }

        return res.json({ ok: true, logoUrl: url, key });
    } catch (err) {
        console.error("nfc/logo upload error:", err);
        return res.status(500).json({ error: "Failed to upload logo" });
    }
});

// ----------------------------------------------------
// ✅ NEW: Create NFC checkout session (one-time payment)
// POST /api/checkout/nfc/session
// Body: { productKey, quantity, profileId, logoUrl?, preview? }
// ----------------------------------------------------
router.post("/nfc/session", requireAuth, async (req, res) => {
    try {
        const userId = req.user?._id;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const user = await User.findById(userId);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const productKey = normalizeProductKey(req.body?.productKey);

        const variantsMap = NFC_PRICE_MAP?.[productKey] || null;
        if (!variantsMap) {
            return res.status(400).json({
                error: "Invalid product",
                code: "INVALID_NFC_PRODUCT",
                productKey,
            });
        }

        // ✅ allow frontend to omit variant for now (default per product)
        const defaultVariant =
            productKey === "plastic-card"
                ? "white"
                : productKey === "metal-card"
                    ? "black"
                    : productKey === "konartag"
                        ? "black"
                        : "";

        const variant = String(req.body?.variant || defaultVariant).trim().toLowerCase();

        const allowedVariants = Object.keys(variantsMap);
        if (!allowedVariants.includes(variant)) {
            return res.status(400).json({
                error: "Invalid variant",
                code: "INVALID_NFC_VARIANT",
                productKey,
                variant,
                allowedVariants,
            });
        }

        const priceId = variantsMap?.[variant];
        if (!priceId) {
            return res.status(500).json({
                error: "Stripe price ID missing in env for this product/variant",
                code: "MISSING_NFC_PRICE_ID",
                productKey,
                variant,
            });
        }

        const quantity = Math.max(1, Math.min(50, Number(req.body?.quantity || 1)));

        const profileId = String(req.body?.profileId || "").trim();
        if (!profileId) {
            return res.status(400).json({ error: "profileId is required", code: "PROFILE_REQUIRED" });
        }

        // Must own the profile
        const profile = await BusinessCard.findOne({ _id: profileId, user: user._id }).select("_id");
        if (!profile) {
            return res.status(403).json({ error: "Invalid profile selection", code: "INVALID_PROFILE" });
        }

        const logoUrl = String(req.body?.logoUrl || "").trim();
        const preview = req.body?.preview && typeof req.body.preview === "object" ? req.body.preview : {};

        const stripeCustomerId = await ensureStripeCustomer(user);

        // Create pending order record (source of truth)
        const order = await NfcOrder.create({
            user: user._id,
            profile: profile._id,
            productKey,
            quantity,
            logoUrl,
            preview: { ...preview, variant }, // ✅ store variant too
            currency: "gbp",
            status: "pending",
            stripeCustomerId,
        });

        const successUrl =
            `${FRONTEND_URL}/products/${productKey}?checkout=success` +
            `&order=${encodeURIComponent(String(order._id))}` +
            `&session_id={CHECKOUT_SESSION_ID}`;

        const cancelUrl =
            `${FRONTEND_URL}/products/${productKey}?checkout=cancel` +
            `&order=${encodeURIComponent(String(order._id))}`;

        const session = await stripe.checkout.sessions.create({
            mode: "payment",
            customer: stripeCustomerId,
            payment_method_types: ["card"],
            allow_promotion_codes: true,

            line_items: [{ price: priceId, quantity }],

            client_reference_id: String(user._id),

            metadata: {
                checkoutType: "nfc_order",
                userId: String(user._id),
                orderId: String(order._id),
                productKey,
                variant,
                quantity: String(quantity),
                profileId: String(profile._id),
                logoUrl: logoUrl || "",
            },

            success_url: successUrl,
            cancel_url: cancelUrl,
        });

        order.stripeCheckoutSessionId = session.id;
        await order.save();

        return res.json({ url: session.url, orderId: String(order._id) });
    } catch (err) {
        console.error("nfc/session error:", err);
        return res.status(500).json({
            error: "Failed to start NFC checkout",
            details: err?.message || String(err),
        });
    }
});


module.exports = router;
