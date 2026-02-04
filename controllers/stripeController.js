// backend/controllers/stripeController.js
const Stripe = require("stripe");
const User = require("../models/user");
const BusinessCard = require("../models/BusinessCard");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

// -------------------------
// Stripe price mapping
// -------------------------
const SUBSCRIPTION_PRICE_MAP = {
    "plus-monthly": process.env.STRIPE_PRICE_PLUS_MONTHLY,
    "plus-quarterly": process.env.STRIPE_PRICE_PLUS_QUARTERLY,
    "plus-yearly": process.env.STRIPE_PRICE_PLUS_YEARLY,

    "teams-monthly": process.env.STRIPE_PRICE_TEAMS_MONTHLY,
    "teams-quarterly": process.env.STRIPE_PRICE_TEAMS_QUARTERLY,
    "teams-yearly": process.env.STRIPE_PRICE_TEAMS_YEARLY,
};

const parsePlanKey = (planKey) => {
    const [plan, interval] = String(planKey || "").split("-");
    if (!["plus", "teams"].includes(plan)) return null;
    if (!["monthly", "quarterly", "yearly"].includes(interval)) return null;
    return { plan, interval };
};

/**
 * Ensure Stripe customer exists for a user (source of truth = DB)
 */
const ensureStripeCustomer = async (userDoc) => {
    if (userDoc?.stripeCustomerId) return userDoc.stripeCustomerId;

    const customer = await stripe.customers.create({
        email: userDoc.email,
        name: userDoc.name || userDoc.username || "",
        metadata: {
            userId: String(userDoc._id),
            username: userDoc.username || "",
        },
    });

    userDoc.stripeCustomerId = customer.id;
    await userDoc.save();
    return customer.id;
};

// ----------------------------------------------------
// STRIPE: Create Subscription Checkout Session
// (PROTECTED BY requireAuth)
// ----------------------------------------------------
const subscribeUser = async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });

        // ✅ always re-fetch fresh user doc (to save stripeCustomerId if needed)
        const user = await User.findById(req.user._id);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        // ✅ must have at least 1 profile before checkout
        const profileCount = await BusinessCard.countDocuments({ user: user._id });
        if (profileCount <= 0) {
            return res.status(400).json({
                error: "You must create a profile before subscribing.",
                code: "PROFILE_REQUIRED",
            });
        }

        const { planKey, returnUrl } = req.body;

        const parsed = parsePlanKey(planKey);
        if (!parsed) return res.status(400).json({ error: "Invalid planKey" });

        const priceId = SUBSCRIPTION_PRICE_MAP[planKey];
        if (!priceId) return res.status(500).json({ error: "Price not configured on server" });

        const baseReturn =
            typeof returnUrl === "string" && returnUrl.trim()
                ? returnUrl.trim()
                : `${FRONTEND_URL}/myprofile?subscribed=1`;

        const successUrl = baseReturn.includes("?")
            ? `${baseReturn}&session_id={CHECKOUT_SESSION_ID}`
            : `${baseReturn}?session_id={CHECKOUT_SESSION_ID}`;

        const cancelUrl = `${FRONTEND_URL}/pricing`;

        // ✅ TEAMS quantity model:
        // - priced per profile
        const quantity = parsed.plan === "teams" ? Math.max(1, profileCount) : 1;

        // ✅ ensure a Stripe customer so later we can UPDATE subscription quantities cleanly
        const stripeCustomerId = await ensureStripeCustomer(user);

        const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            customer: stripeCustomerId,
            payment_method_types: ["card"],
            allow_promotion_codes: true,

            line_items: [{ price: priceId, quantity }],

            success_url: successUrl,
            cancel_url: cancelUrl,

            client_reference_id: String(user._id),
            metadata: {
                userId: String(user._id),
                plan: parsed.plan,
                interval: parsed.interval,
                planKey,
                teamsQuantityAtCheckout: String(quantity),
                checkoutType: "base_subscription",
            },

            subscription_data: {
                metadata: {
                    userId: String(user._id),
                    plan: parsed.plan,
                    interval: parsed.interval,
                    planKey,
                    checkoutType: "base_subscription",
                },
            },
        });

        return res.json({ url: session.url });
    } catch (err) {
        console.error("subscribeUser error:", err);
        return res.status(500).json({ error: "Failed to start subscription" });
    }
};

// ----------------------------------------------------
// STRIPE: Cancel Subscription (cancel at period end)
// (PROTECTED BY requireAuth)
// ----------------------------------------------------
const cancelSubscription = async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });

        const user = req.user;

        if (user.stripeSubscriptionId) {
            await stripe.subscriptions.update(user.stripeSubscriptionId, {
                cancel_at_period_end: true,
            });

            await User.findByIdAndUpdate(user._id, {
                $set: { subscriptionStatus: "cancelling" },
            });

            return res.json({ success: true, message: "Subscription will cancel at period end" });
        }

        if (!user.stripeCustomerId) return res.status(400).json({ error: "No subscription found" });

        const subscriptions = await stripe.subscriptions.list({
            customer: user.stripeCustomerId,
            status: "active",
            limit: 1,
        });

        if (!subscriptions.data.length) return res.status(400).json({ error: "No active subscription found" });

        await stripe.subscriptions.update(subscriptions.data[0].id, {
            cancel_at_period_end: true,
        });

        await User.findByIdAndUpdate(user._id, {
            $set: { stripeSubscriptionId: subscriptions.data[0].id, subscriptionStatus: "cancelling" },
        });

        return res.json({ success: true, message: "Subscription will cancel at period end" });
    } catch (err) {
        console.error("cancelSubscription error:", err);
        return res.status(500).json({ error: "Failed to cancel subscription" });
    }
};

// ----------------------------------------------------
// STRIPE: Subscription status (from DB)
// (PROTECTED BY requireAuth)
// ----------------------------------------------------
const checkSubscriptionStatus = async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });

        const user = req.user;

        return res.json({
            active: !!user.isSubscribed,
            plan: user.plan || "free",
            interval: user.planInterval || "monthly",
            status: user.subscriptionStatus || "free",
            currentPeriodEnd: user.currentPeriodEnd || null,
        });
    } catch (err) {
        console.error("checkSubscriptionStatus error:", err);
        return res.status(500).json({ error: "Failed to load subscription status" });
    }
};

// ----------------------------------------------------
// STRIPE: Sync subscription status (best effort)
// (PROTECTED BY requireAuth)
// ----------------------------------------------------
const syncSubscriptions = async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });

        const user = await User.findById(req.user._id);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        if (!user.stripeCustomerId) {
            return res.json({ success: true, synced: false, reason: "no_stripe_customer" });
        }

        const subs = await stripe.subscriptions.list({
            customer: user.stripeCustomerId,
            status: "all",
            limit: 10,
        });

        const active = subs.data.find((s) => ["active", "trialing"].includes(s.status));
        const latest = active || subs.data[0];

        if (!latest) {
            user.isSubscribed = false;
            user.subscriptionStatus = "free";
            user.plan = "free";
            user.stripeSubscriptionId = undefined;
            await user.save();
            return res.json({ success: true, synced: true, isSubscribed: false });
        }

        user.stripeSubscriptionId = latest.id;
        user.subscriptionStatus = latest.status;
        user.isSubscribed = ["active", "trialing"].includes(latest.status);

        if (latest.current_period_end) {
            user.currentPeriodEnd = new Date(latest.current_period_end * 1000);
        }

        await user.save();

        return res.json({
            success: true,
            synced: true,
            isSubscribed: user.isSubscribed,
            subscriptionStatus: user.subscriptionStatus,
            currentPeriodEnd: user.currentPeriodEnd || null,
        });
    } catch (err) {
        console.error("syncSubscriptions error:", err);
        return res.status(500).json({ error: "Failed to sync subscriptions" });
    }
};

// ----------------------------------------------------
// STRIPE: Customer Portal (manage subscription)
// (PROTECTED BY requireAuth)
// ----------------------------------------------------
const createBillingPortal = async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });

        const user = req.user;

        if (!user.stripeCustomerId) {
            return res.status(400).json({ error: "No Stripe customer found for this user" });
        }

        const portalSession = await stripe.billingPortal.sessions.create({
            customer: user.stripeCustomerId,
            return_url: `${FRONTEND_URL}/myprofile`,
        });

        return res.json({ url: portalSession.url });
    } catch (err) {
        console.error("createBillingPortal error:", err);
        return res.status(500).json({ error: "Failed to create billing portal session" });
    }
};

module.exports = {
    subscribeUser,
    cancelSubscription,
    checkSubscriptionStatus,
    syncSubscriptions,
    createBillingPortal,
};
