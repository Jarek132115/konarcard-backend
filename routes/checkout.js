// backend/routes/checkout.js
const express = require("express");
const router = express.Router();

const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ✅ you likely already have this middleware
const { requireAuth } = require("../helpers/auth");

// ✅ make sure this path is correct for your repo:
const User = require("../models/user");

/**
 * =========================================================
 * CONFIG
 * =========================================================
 */

// Frontend base for redirects
const FRONTEND_URL =
    process.env.FRONTEND_URL || "http://localhost:5173";

// Teams price IDs (use env first)
const TEAMS_PRICE_IDS = [
    process.env.STRIPE_PRICE_TEAMS_MONTHLY,
    process.env.STRIPE_PRICE_TEAMS_QUARTERLY,
    process.env.STRIPE_PRICE_TEAMS_YEARLY,
].filter(Boolean);

// Fallback: your hardcoded price (ONLY if you didn't set env vars)
const FALLBACK_TEAMS_PRICE_ID = "price_1RWz48P7pC1ilLXAGhstIic4";

// Choose which Teams price to use (default monthly)
const DEFAULT_TEAMS_PRICE_ID =
    TEAMS_PRICE_IDS[0] || FALLBACK_TEAMS_PRICE_ID;

// Stripe webhook secret
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

/**
 * Helper: ensure we have a Stripe Customer for this user
 */
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
 * =========================================================
 * ✅ POST /api/checkout/teams
 * - Creates a subscription checkout session for Teams
 * - desiredQuantity controls number of profiles allowed (you will enforce via logic)
 * =========================================================
 */
router.post("/teams", requireAuth, async (req, res) => {
    try {
        const userId = req.user?._id;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const user = await User.findById(userId);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        // quantity comes from frontend as desiredQuantity
        const desiredQuantity = Math.max(
            1,
            Number(req.body?.desiredQuantity || req.body?.quantity || 1)
        );

        const stripeCustomerId = await ensureStripeCustomer(user);

        // ✅ success goes back to profiles page (no redirect to claim page)
        const successUrl = `${FRONTEND_URL}/profiles?subscribed=1&session_id={CHECKOUT_SESSION_ID}`;
        const cancelUrl = `${FRONTEND_URL}/profiles?checkout_cancelled=1`;

        const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            customer: stripeCustomerId,
            payment_method_types: ["card"],

            line_items: [
                {
                    price: DEFAULT_TEAMS_PRICE_ID,
                    quantity: desiredQuantity,
                },
            ],

            // IMPORTANT: so webhook can link checkout -> your user
            metadata: {
                userId: String(user._id),
                desiredQuantity: String(desiredQuantity),
                checkoutType: "teams",
            },

            subscription_data: {
                metadata: {
                    userId: String(user._id),
                    desiredQuantity: String(desiredQuantity),
                    checkoutType: "teams",
                },
            },

            success_url: successUrl,
            cancel_url: cancelUrl,
        });

        return res.json({ url: session.url });
    } catch (err) {
        console.error("Teams checkout error:", err);
        return res.status(500).json({ error: "Stripe checkout session failed" });
    }
});

/**
 * =========================================================
 * ✅ Stripe Webhook
 * - updates user.plan = "teams"
 * - stores stripeSubscriptionId
 * - stores stripeCustomerId if missing
 *
 * IMPORTANT SERVER NOTE:
 * This webhook route MUST use express.raw middleware and must be mounted
 * before express.json() for this endpoint.
 * See notes after the code.
 * =========================================================
 */
router.post(
    "/webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {
        if (!STRIPE_WEBHOOK_SECRET) {
            console.error("Missing STRIPE_WEBHOOK_SECRET in env");
            return res.status(500).send("Webhook not configured");
        }

        const sig = req.headers["stripe-signature"];
        let event;

        try {
            event = stripe.webhooks.constructEvent(
                req.body,
                sig,
                STRIPE_WEBHOOK_SECRET
            );
        } catch (err) {
            console.error("Webhook signature verify failed:", err.message);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        try {
            // ✅ This event fires when checkout completes
            if (event.type === "checkout.session.completed") {
                const session = event.data.object;

                const userId = session?.metadata?.userId;
                const subscriptionId = session?.subscription;
                const customerId = session?.customer;

                if (userId) {
                    const user = await User.findById(userId);
                    if (user) {
                        // Update user to Teams
                        user.plan = "teams";

                        if (customerId && !user.stripeCustomerId) {
                            user.stripeCustomerId = customerId;
                        }

                        if (subscriptionId) {
                            user.stripeSubscriptionId = subscriptionId;
                        }

                        await user.save();
                    }
                }
            }

            // ✅ Also handle subscription updates (quantity changes etc.)
            if (
                event.type === "customer.subscription.updated" ||
                event.type === "customer.subscription.created"
            ) {
                const sub = event.data.object;
                const userId = sub?.metadata?.userId;

                if (userId) {
                    const user = await User.findById(userId);
                    if (user) {
                        user.plan = "teams";
                        user.stripeSubscriptionId = sub.id;
                        if (sub.customer && !user.stripeCustomerId) {
                            user.stripeCustomerId = sub.customer;
                        }
                        await user.save();
                    }
                }
            }

            return res.json({ received: true });
        } catch (err) {
            console.error("Webhook handler error:", err);
            return res.status(500).send("Webhook handler failed");
        }
    }
);

module.exports = router;
