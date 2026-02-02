// backend/routes/webHook.js
const express = require("express");
const router = express.Router();
const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const User = require("../models/user");

const sendEmail = require("../utils/SendEmail");
const { orderConfirmationTemplate } = require("../utils/emailTemplates");

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

/**
 * Map Stripe price IDs -> your internal plan + interval
 * (base subscription line item)
 */
const PRICE_TO_PLAN = {
  // PLUS
  [process.env.STRIPE_PRICE_PLUS_MONTHLY]: { plan: "plus", interval: "monthly" },
  [process.env.STRIPE_PRICE_PLUS_QUARTERLY]: { plan: "plus", interval: "quarterly" },
  [process.env.STRIPE_PRICE_PLUS_YEARLY]: { plan: "plus", interval: "yearly" },

  // TEAMS
  [process.env.STRIPE_PRICE_TEAMS_MONTHLY]: { plan: "teams", interval: "monthly" },
  [process.env.STRIPE_PRICE_TEAMS_QUARTERLY]: { plan: "teams", interval: "quarterly" },
  [process.env.STRIPE_PRICE_TEAMS_YEARLY]: { plan: "teams", interval: "yearly" },
};

/**
 * Optional add-on: extra profiles (if you ever use Plus + add-on quantity billing)
 */
const EXTRA_PROFILE_PRICE_IDS = [
  process.env.STRIPE_PRICE_EXTRA_PROFILE_MONTHLY,
  process.env.STRIPE_PRICE_EXTRA_PROFILE_QUARTERLY,
  process.env.STRIPE_PRICE_EXTRA_PROFILE_YEARLY,
].filter(Boolean);

function isActiveStatus(status) {
  return status === "active" || status === "trialing";
}

function parsePlanKey(planKey) {
  const [p, i] = String(planKey || "").split("-");
  const plan = ["plus", "teams"].includes(p) ? p : null;
  const interval = ["monthly", "quarterly", "yearly"].includes(i) ? i : null;
  if (!plan || !interval) return null;
  return { plan, interval };
}

// Update by customerId (fallback), with safe $set / $unset handling
async function updateUserByCustomer(customerId, { set = {}, unset = {} }) {
  if (!customerId) return;

  const update = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;
  if (!Object.keys(update).length) return;

  await User.findOneAndUpdate({ stripeCustomerId: customerId }, update, { new: true });
}

// Update by userId (best), with safe $set / $unset handling
async function updateUserById(userId, { set = {}, unset = {} }) {
  if (!userId) return;

  const update = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;
  if (!Object.keys(update).length) return;

  await User.findByIdAndUpdate(userId, update, { new: true });
}

/**
 * Extract base plan + interval + extraProfilesQty from a Stripe subscription object
 * NOTE: expects sub expanded with items.data.price
 */
function extractPlanAndExtrasFromSubscription(sub, sessionMetadataPlanKey) {
  const items = Array.isArray(sub?.items?.data) ? sub.items.data : [];

  // Base plan: find the first line item whose price id is in PRICE_TO_PLAN
  let plan = null;
  let interval = null;

  for (const it of items) {
    const priceId = it?.price?.id;
    const mapped = priceId ? PRICE_TO_PLAN[priceId] : null;
    if (mapped?.plan && mapped?.interval) {
      plan = mapped.plan;
      interval = mapped.interval;
      break;
    }
  }

  // Fallback to metadata planKey (do not overwrite if unknown)
  if ((!plan || !interval) && sessionMetadataPlanKey) {
    const parsed = parsePlanKey(sessionMetadataPlanKey);
    if (parsed) {
      plan = plan || parsed.plan;
      interval = interval || parsed.interval;
    }
  }

  // Extras: sum quantity of add-on line items
  let extraProfilesQty = 0;
  if (EXTRA_PROFILE_PRICE_IDS.length) {
    for (const it of items) {
      const priceId = it?.price?.id;
      if (priceId && EXTRA_PROFILE_PRICE_IDS.includes(priceId)) {
        extraProfilesQty += Number(it?.quantity || 0);
      }
    }
  }

  return { plan, interval, extraProfilesQty };
}

// IMPORTANT: express.raw must be used for Stripe signature verification
router.post("/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  if (!endpointSecret) {
    console.error("⚠️ Missing STRIPE_WEBHOOK_SECRET");
    return res.status(500).send("Webhook not configured");
  }

  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error("⚠️ Stripe webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // -------------------------
    // checkout.session.completed
    // -------------------------
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      // A) Subscription checkout
      if (session.mode === "subscription") {
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        const userId = session.metadata?.userId;

        // Retrieve subscription so we can read price + status + period end + add-ons
        const sub = await stripe.subscriptions.retrieve(subscriptionId, {
          expand: ["items.data.price"],
        });

        const status = sub.status;
        const currentPeriodEnd = sub.current_period_end
          ? new Date(sub.current_period_end * 1000)
          : undefined;

        const { plan, interval, extraProfilesQty } =
          extractPlanAndExtrasFromSubscription(sub, session.metadata?.planKey);

        const set = {
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
          subscriptionStatus: status || "active",
          currentPeriodEnd,
          isSubscribed: isActiveStatus(status),
          extraProfilesQty: Number.isFinite(extraProfilesQty) ? extraProfilesQty : 0,
        };

        // Only set plan fields if known
        if (plan) set.plan = plan;
        if (interval) set.planInterval = interval;

        // If now subscribed, clear trial
        const unset = isActiveStatus(status) ? { trialExpires: "" } : {};

        if (userId) await updateUserById(userId, { set, unset });
        else await updateUserByCustomer(customerId, { set, unset });
      }

      // B) One-time payment checkout (NFC cards)
      if (session.mode === "payment") {
        const customerEmail = session.customer_details?.email;
        const amountPaid = session.amount_total
          ? (session.amount_total / 100).toFixed(2)
          : null;

        await sendEmail(
          process.env.EMAIL_USER,
          amountPaid ? `New Konar Card Order - £${amountPaid}` : `New Konar Card Order`,
          `<p>New order from: ${customerEmail || "Unknown email"}</p>${amountPaid ? `<p>Total: £${amountPaid}</p>` : ""
          }`
        );

        if (customerEmail && amountPaid) {
          await sendEmail(
            customerEmail,
            "Your Konar Card Order Confirmation",
            orderConfirmationTemplate(customerEmail, amountPaid)
          );
        }
      }
    }

    // -------------------------
    // customer.subscription.created
    // -------------------------
    if (event.type === "customer.subscription.created") {
      const sub = event.data.object;

      const customerId = sub.customer;
      const subscriptionId = sub.id;
      const status = sub.status;

      const currentPeriodEnd = sub.current_period_end
        ? new Date(sub.current_period_end * 1000)
        : undefined;

      const fullSub = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ["items.data.price"],
      });

      const { plan, interval, extraProfilesQty } =
        extractPlanAndExtrasFromSubscription(fullSub, null);

      const set = {
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: status || "active",
        currentPeriodEnd,
        isSubscribed: isActiveStatus(status),
        extraProfilesQty: Number.isFinite(extraProfilesQty) ? extraProfilesQty : 0,
      };

      if (plan) set.plan = plan;
      if (interval) set.planInterval = interval;

      const unset = isActiveStatus(status) ? { trialExpires: "" } : {};

      await updateUserByCustomer(customerId, { set, unset });
    }

    // -------------------------
    // customer.subscription.updated
    // -------------------------
    if (event.type === "customer.subscription.updated") {
      const sub = event.data.object;

      const customerId = sub.customer;
      const subscriptionId = sub.id;
      const status = sub.status;

      const currentPeriodEnd = sub.current_period_end
        ? new Date(sub.current_period_end * 1000)
        : undefined;

      // Retrieve expanded to reliably read price ids + add-on qty
      const fullSub = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ["items.data.price"],
      });

      const { plan, interval, extraProfilesQty } =
        extractPlanAndExtrasFromSubscription(fullSub, null);

      const set = {
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: status || "active",
        currentPeriodEnd,
        isSubscribed: isActiveStatus(status),
        extraProfilesQty: Number.isFinite(extraProfilesQty) ? extraProfilesQty : 0,
      };

      if (plan) set.plan = plan;
      if (interval) set.planInterval = interval;

      const unset = isActiveStatus(status) ? { trialExpires: "" } : {};

      await updateUserByCustomer(customerId, { set, unset });
    }

    // -------------------------
    // invoice.paid
    // -------------------------
    if (event.type === "invoice.paid") {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      const subscriptionId = invoice.subscription;

      let extraProfilesQty = 0;
      let plan = null;
      let interval = null;

      if (subscriptionId) {
        try {
          const fullSub = await stripe.subscriptions.retrieve(subscriptionId, {
            expand: ["items.data.price"],
          });
          const extracted = extractPlanAndExtrasFromSubscription(fullSub, null);
          extraProfilesQty = extracted.extraProfilesQty || 0;
          plan = extracted.plan;
          interval = extracted.interval;
        } catch {
          // ignore; still mark active
        }
      }

      const set = {
        stripeSubscriptionId: subscriptionId || undefined,
        subscriptionStatus: "active",
        isSubscribed: true,
        extraProfilesQty: Number.isFinite(extraProfilesQty) ? extraProfilesQty : 0,
      };

      if (plan) set.plan = plan;
      if (interval) set.planInterval = interval;

      await updateUserByCustomer(customerId, {
        set,
        unset: { trialExpires: "" },
      });
    }

    // -------------------------
    // invoice.payment_failed
    // -------------------------
    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      const subscriptionId = invoice.subscription;

      await updateUserByCustomer(customerId, {
        set: {
          stripeSubscriptionId: subscriptionId || undefined,
          subscriptionStatus: "past_due",
          isSubscribed: false,
        },
      });
    }

    // -------------------------
    // customer.subscription.deleted
    // -------------------------
    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      const customerId = sub.customer;

      await updateUserByCustomer(customerId, {
        set: {
          plan: "free",
          planInterval: "monthly",
          subscriptionStatus: "canceled",
          isSubscribed: false,
          extraProfilesQty: 0,
        },
        unset: {
          currentPeriodEnd: "",
          stripeSubscriptionId: "",
        },
      });
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook handler error:", err);
    return res.status(500).send("Webhook handler failed");
  }
});

module.exports = router;
