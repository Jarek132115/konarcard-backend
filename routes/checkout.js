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
        .replace(/[^a-z0-9-]/g, "")

function getTeamsPriceId(interval = "monthly") {
    const i = String(interval || "monthly").toLowerCase();
    if (i === "monthly") return process.env.STRIPE_PRICE_TEAMS_MONTHLY;
    if (i === "quarterly") return process.env.STRIPE_PRICE_TEAMS_QUARTERLY;
    if (i === "yearly") return process.env.STRIPE_PRICE_TEAMS_YEARLY;
    return process.env.STRIPE_PRICE_TEAMS_MONTHLY;
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
 *  - desiredQuantity OR quantity: number (default 2, min 2)
 *  - claimedSlug: the new profile slug user wants to claim (required)
 */
router.post("/teams", requireAuth, async (req, res) => {
    try {
        const userId = req.user?._id;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const user = await User.findById(userId);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const interval = String(req.body?.interval || "monthly").toLowerCase();
        const desiredQuantity = Math.max(
            2,
            Number(req.body?.desiredQuantity || req.body?.quantity || 2)
        );

        const claimedSlugRaw = req.body?.claimedSlug || req.body?.profile_slug || "";
        const claimedSlug = safeSlug(claimedSlugRaw);

        if (!claimedSlug || claimedSlug.length < 3) {
            return res.status(400).json({
                error: "claimedSlug is required and must be at least 3 chars",
                code: "CLAIMED_SLUG_REQUIRED",
            });
        }

        // Server-side availability check (prevents obvious duplicates)
        const exists = await BusinessCard.findOne({ profile_slug: claimedSlug }).select("_id");
        if (exists) {
            return res.status(409).json({ error: "Profile slug already exists", code: "SLUG_TAKEN" });
        }

        const priceId = getTeamsPriceId(interval);
        if (!priceId) {
            return res.status(500).json({
                error: "Teams price ID missing in env",
                code: "MISSING_TEAMS_PRICE_ID",
            });
        }

        const stripeCustomerId = await ensureStripeCustomer(user);

        // ✅ include claimedSlug + qty in return URL so frontend can refetch + show status
        const successUrl =
            `${FRONTEND_URL}/profiles?checkout=success` +
            `&slug=${encodeURIComponent(claimedSlug)}` +
            `&qty=${encodeURIComponent(String(desiredQuantity))}` +
            `&session_id={CHECKOUT_SESSION_ID}`;

        const cancelUrl = `${FRONTEND_URL}/profiles?checkout=cancel`;

        const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            customer: stripeCustomerId,
            payment_method_types: ["card"],

            // Optional: helpful in Stripe dashboard
            client_reference_id: String(user._id),

            line_items: [{ price: priceId, quantity: desiredQuantity }],

            metadata: {
                userId: String(user._id),
                planKey: `teams-${interval}`,
                claimedSlug,
                desiredQuantity: String(desiredQuantity),
                checkoutType: "teams_add_profile",
            },

            subscription_data: {
                metadata: {
                    userId: String(user._id),
                    planKey: `teams-${interval}`,
                    claimedSlug,
                    desiredQuantity: String(desiredQuantity),
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
