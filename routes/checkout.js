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

/**
 * Find subscription item IDs for:
 * - Teams base item (one of TEAMS_PRICE_IDS)
 * - Extra profiles add-on item (one of EXTRA_PROFILE_PRICE_IDS)
 */
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

/**
 * Create and attempt to charge an immediate proration invoice.
 * This matches your requirement: if they add mid-cycle, charge the proportional amount now.
 */
async function invoiceAndPayNow({ customerId, subscriptionId }) {
    // Create invoice for the subscription
    const invoice = await stripe.invoices.create({
        customer: customerId,
        subscription: subscriptionId,
        collection_method: "charge_automatically",
        auto_advance: true,
    });

    // Finalize then attempt pay
    const finalized = await stripe.invoices.finalizeInvoice(invoice.id);

    // If amount_due is 0, nothing to pay
    if (!finalized || !finalized.amount_due || finalized.amount_due <= 0) {
        return { paid: true, invoiceId: finalized?.id, amount_due: 0 };
    }

    const paid = await stripe.invoices.pay(finalized.id);
    return { paid: paid?.paid === true, invoiceId: paid?.id, amount_due: paid?.amount_due || 0 };
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
 *
 * ✅ IMPORTANT:
 * If already subscribed to Teams, we UPDATE the existing subscription (no second subscription)
 * and charge prorations immediately.
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

        // ✅ If user already has an active Teams subscription: UPDATE + PRORATE NOW
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

                // Build update items:
                // - teams stays qty 1
                // - extra item: set qty = extraProfilesQty
                const items = [{ id: teamsItem.id, quantity: 1 }];

                if (extraItem) {
                    items.push({ id: extraItem.id, quantity: extraProfilesQty });
                } else {
                    // Add the extra price line if missing
                    items.push({ price: extraPriceId, quantity: extraProfilesQty });
                }

                // Update subscription (keeps billing_cycle_anchor, creates prorations)
                await stripe.subscriptions.update(sub.id, {
                    items,
                    proration_behavior: "create_prorations",
                });

                // Charge prorations immediately (your requirement)
                let prorationResult = { paid: false };
                try {
                    prorationResult = await invoiceAndPayNow({
                        customerId: stripeCustomerId,
                        subscriptionId: sub.id,
                    });
                } catch (e) {
                    // If invoice fails (no default payment method etc.), still return success so UI can continue.
                    console.error("Proration invoice/pay failed:", e?.message || e);
                    prorationResult = { paid: false, error: "proration_charge_failed" };
                }

                return res.json({
                    updated: true,
                    mode: "subscription_update",
                    desiredProfiles,
                    extraProfilesQty,
                    proration: prorationResult,
                    // frontend can just refetch user + profiles after this
                });
            }
        }

        // ✅ Otherwise: create a new Teams subscription checkout session
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

            // Two-line-item subscription
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
