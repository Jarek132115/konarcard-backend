// backend/controllers/stripeController.js
const Stripe = require("stripe");
const User = require("../models/user");
const BusinessCard = require("../models/BusinessCard");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

const STRIPE_PRICE_PLUS_MONTHLY = process.env.NEW_STRIPE_PRICE_PLUS_MONTHLY;
const STRIPE_PRICE_PLUS_YEARLY = process.env.NEW_STRIPE_PRICE_PLUS_YEARLY;
const STRIPE_PRICE_EXTRA_PROFILE_MONTHLY =
    process.env.NEW_STRIPE_PRICE_EXTRA_PROFILE_MONTHLY;

const ALLOWED_PLAN_KEYS = new Set([
    "plus-monthly",
    "plus-yearly",
    "teams-monthly",
]);

const parsePlanKey = (planKey) => {
    const [plan, interval] = String(planKey || "").split("-");
    if (!["plus", "teams"].includes(plan)) return null;
    if (!["monthly", "yearly"].includes(interval)) return null;
    return { plan, interval };
};

const getPlusPriceIdForInterval = (interval) => {
    if (interval === "monthly") return STRIPE_PRICE_PLUS_MONTHLY;
    if (interval === "yearly") return STRIPE_PRICE_PLUS_YEARLY;
    return null;
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

/**
 * Build Stripe line items for a selected plan.
 *
 * Pricing model:
 * - Plus Monthly = £5
 * - Plus Yearly = yearly price
 * - Teams Monthly = Plus Monthly + £2 per extra profile
 *
 * Teams is NOT a standalone Stripe product bundle.
 * Teams uses:
 * - 1 x Plus Monthly
 * - N x Extra Profile Monthly
 */
const buildSubscriptionLineItems = ({ plan, interval, profileCount }) => {
    if (plan === "plus") {
        const plusPriceId = getPlusPriceIdForInterval(interval);
        if (!plusPriceId) {
            throw new Error("Plus price is not configured for this interval");
        }

        return [{ price: plusPriceId, quantity: 1 }];
    }

    if (plan === "teams") {
        if (interval !== "monthly") {
            throw new Error("Teams is currently only available on monthly billing");
        }

        if (!STRIPE_PRICE_PLUS_MONTHLY) {
            throw new Error("Plus monthly price is not configured on server");
        }

        if (!STRIPE_PRICE_EXTRA_PROFILE_MONTHLY) {
            throw new Error("Extra profile monthly price is not configured on server");
        }

        const safeProfileCount = Math.max(1, Number(profileCount) || 1);
        const extraProfiles = Math.max(0, safeProfileCount - 1);

        const lineItems = [{ price: STRIPE_PRICE_PLUS_MONTHLY, quantity: 1 }];

        if (extraProfiles > 0) {
            lineItems.push({
                price: STRIPE_PRICE_EXTRA_PROFILE_MONTHLY,
                quantity: extraProfiles,
            });
        }

        return lineItems;
    }

    throw new Error("Unsupported plan");
};

// ----------------------------------------------------
// STRIPE: Create Subscription Checkout Session
// (PROTECTED BY requireAuth)
// ----------------------------------------------------
const subscribeUser = async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });

        const user = await User.findById(req.user._id);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const profileCount = await BusinessCard.countDocuments({ user: user._id });

        if (profileCount <= 0) {
            return res.status(400).json({
                error: "You must create a profile before subscribing.",
                code: "PROFILE_REQUIRED",
            });
        }

        const { planKey, returnUrl } = req.body;

        if (!ALLOWED_PLAN_KEYS.has(String(planKey || ""))) {
            return res.status(400).json({ error: "Invalid planKey" });
        }

        const parsed = parsePlanKey(planKey);
        if (!parsed) {
            return res.status(400).json({ error: "Invalid planKey" });
        }

        const baseReturn =
            typeof returnUrl === "string" && returnUrl.trim()
                ? returnUrl.trim()
                : `${FRONTEND_URL}/myprofile?subscribed=1`;

        const successUrl = baseReturn.includes("?")
            ? `${baseReturn}&session_id={CHECKOUT_SESSION_ID}`
            : `${baseReturn}?session_id={CHECKOUT_SESSION_ID}`;

        const cancelUrl = `${FRONTEND_URL}/pricing`;

        const stripeCustomerId = await ensureStripeCustomer(user);

        let lineItems;
        try {
            lineItems = buildSubscriptionLineItems({
                plan: parsed.plan,
                interval: parsed.interval,
                profileCount,
            });
        } catch (pricingError) {
            console.error("buildSubscriptionLineItems error:", pricingError);
            return res.status(500).json({
                error: pricingError.message || "Subscription pricing is not configured correctly",
            });
        }

        const extraProfiles = Math.max(0, Number(profileCount) - 1);

        const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            customer: stripeCustomerId,
            payment_method_types: ["card"],
            allow_promotion_codes: true,
            line_items: lineItems,
            success_url: successUrl,
            cancel_url: cancelUrl,
            client_reference_id: String(user._id),
            metadata: {
                userId: String(user._id),
                plan: parsed.plan,
                interval: parsed.interval,
                planKey,
                profileCountAtCheckout: String(profileCount),
                extraProfilesAtCheckout: String(extraProfiles),
                checkoutType: "base_subscription",
            },
            subscription_data: {
                metadata: {
                    userId: String(user._id),
                    plan: parsed.plan,
                    interval: parsed.interval,
                    planKey,
                    profileCountAtCheckout: String(profileCount),
                    extraProfilesAtCheckout: String(extraProfiles),
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

            return res.json({
                success: true,
                message: "Subscription will cancel at period end",
            });
        }

        if (!user.stripeCustomerId) {
            return res.status(400).json({ error: "No subscription found" });
        }

        const subscriptions = await stripe.subscriptions.list({
            customer: user.stripeCustomerId,
            status: "active",
            limit: 1,
        });

        if (!subscriptions.data.length) {
            return res.status(400).json({ error: "No active subscription found" });
        }

        await stripe.subscriptions.update(subscriptions.data[0].id, {
            cancel_at_period_end: true,
        });

        await User.findByIdAndUpdate(user._id, {
            $set: {
                stripeSubscriptionId: subscriptions.data[0].id,
                subscriptionStatus: "cancelling",
            },
        });

        return res.json({
            success: true,
            message: "Subscription will cancel at period end",
        });
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
            user.planInterval = "monthly";
            user.stripeSubscriptionId = undefined;
            user.currentPeriodEnd = null;
            await user.save();

            return res.json({ success: true, synced: true, isSubscribed: false });
        }

        user.stripeSubscriptionId = latest.id;
        user.subscriptionStatus = latest.status;
        user.isSubscribed = ["active", "trialing"].includes(latest.status);

        if (latest.current_period_end) {
            user.currentPeriodEnd = new Date(latest.current_period_end * 1000);
        }

        const metadataPlan = String(latest.metadata?.plan || "").toLowerCase();
        const metadataInterval = String(latest.metadata?.interval || "").toLowerCase();

        if (metadataPlan === "plus" || metadataPlan === "teams") {
            user.plan = metadataPlan;
        }

        if (metadataInterval === "monthly" || metadataInterval === "yearly") {
            user.planInterval = metadataInterval;
        }

        await user.save();

        return res.json({
            success: true,
            synced: true,
            isSubscribed: user.isSubscribed,
            subscriptionStatus: user.subscriptionStatus,
            currentPeriodEnd: user.currentPeriodEnd || null,
            plan: user.plan || "free",
            interval: user.planInterval || "monthly",
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