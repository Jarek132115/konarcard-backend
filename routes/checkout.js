// backend/routes/checkout.js
const express = require("express");
const router = express.Router();

const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const { requireAuth } = require("../helpers/auth");
const User = require("../models/user");
const BusinessCard = require("../models/BusinessCard");

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

const safeSlug = (v) =>
    String(v || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "");

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

/**
 * POST /api/checkout/teams
 * Body:
 *  - interval: monthly|quarterly|yearly (default monthly)
 *  - desiredProfiles OR desiredQuantity OR quantity: number (default 2, min 2)
 *      NOTE: this is the TOTAL profiles the user wants to have.
 *  - claimedSlug: the new profile slug user wants to claim (required)
 *
 * Pricing model:
 *  - Teams base = qty 1
 *  - Extra profiles add-on = £1.95 each (qty = desiredProfiles - 1)
 *  - Stripe handles proration automatically on subscription changes.
 */
router.post("/teams", requireAuth, async (req, res) => {
    try {
        const userId = req.user?._id;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const user = await User.findById(userId);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const interval = String(req.body?.interval || "monthly").toLowerCase();

        // TOTAL number of profiles user wants
        const desiredProfiles = Math.max(
            2,
            Number(req.body?.desiredProfiles || req.body?.desiredQuantity || req.body?.quantity || 2)
        );

        // Extra profiles beyond the 1 included with Teams
        const extraProfilesQty = Math.max(1, desiredProfiles - 1);

        const claimedSlugRaw = req.body?.claimedSlug || req.body?.profile_slug || "";
        const claimedSlug = safeSlug(claimedSlugRaw);

        if (!claimedSlug || claimedSlug.length < 3) {
            return res.status(400).json({
                error: "claimedSlug is required and must be at least 3 chars",
                code: "CLAIMED_SLUG_REQUIRED",
            });
        }

        // Server-side availability check
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

            // Helpful for Stripe dashboard
            client_reference_id: String(user._id),

            // IMPORTANT: Two-line-item subscription
            // - Teams base (qty 1)
            // - Extra profiles add-on (qty desiredProfiles - 1)
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

module.exports = router;
