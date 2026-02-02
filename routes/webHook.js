// backend/routes/webHook.js
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
 * Add-on (optional): extra profiles for PLUS
 */
const EXTRA_PROFILE_PRICE_IDS = [
  process.env.STRIPE_PRICE_EXTRA_PROFILE_MONTHLY,
  process.env.STRIPE_PRICE_EXTRA_PROFILE_QUARTERLY,
  process.env.STRIPE_PRICE_EXTRA_PROFILE_YEARLY,
].filter(Boolean);

/**
 * TEAMS price IDs list (used to find Teams item + quantity)
 */
const TEAMS_PRICE_IDS = [
  process.env.STRIPE_PRICE_TEAMS_MONTHLY,
  process.env.STRIPE_PRICE_TEAMS_QUARTERLY,
  process.env.STRIPE_PRICE_TEAMS_YEARLY,
].filter(Boolean);

function isActiveStatus(status) {
  return status === "active" || status === "trialing";
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
 * Extract:
 * - plan + interval (plus/teams)
 * - extraProfilesQty (plus add-on)
 * - teamsProfilesQty (teams subscription item quantity)
 * - store teams item ids for reconciliation/debug
 *
 * NOTE: expects subscription expanded with items.data.price
 */
function extractEntitlementsFromSubscription(sub) {
  const items = Array.isArray(sub?.items?.data) ? sub.items.data : [];

  // Base plan: find first item matching PRICE_TO_PLAN
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

  // PLUS add-on quantity
  let extraProfilesQty = 0;
  if (EXTRA_PROFILE_PRICE_IDS.length) {
    for (const it of items) {
      const priceId = it?.price?.id;
      if (priceId && EXTRA_PROFILE_PRICE_IDS.includes(priceId)) {
        extraProfilesQty += Number(it?.quantity || 0);
      }
    }
  }

  // TEAMS quantity (the teams base line item quantity)
  let teamsProfilesQty = 1;
  let teamsStripeItemId = undefined;
  let teamsStripePriceId = undefined;

  if (TEAMS_PRICE_IDS.length) {
    const teamsItem = items.find((it) => {
      const pid = it?.price?.id;
      return pid && TEAMS_PRICE_IDS.includes(pid);
    });

    if (teamsItem) {
      teamsProfilesQty = Math.max(1, Number(teamsItem.quantity || 1));
      teamsStripeItemId = teamsItem.id;
      teamsStripePriceId = teamsItem?.price?.id;
    }
  }

  return { plan, interval, extraProfilesQty, teamsProfilesQty, teamsStripeItemId, teamsStripePriceId };
}

/**
 * ✅ IMPORTANT:
 * This file is now a SINGLE handler function.
 * index.js mounts it like:
 *   app.post("/api/checkout/webhook", express.raw({type:"application/json"}), stripeWebhookHandler)
 *
 * So we MUST export (req, res) directly and NOT use router.post() here.
 */
module.exports = async function stripeWebhookHandler(req, res) {
  if (!endpointSecret) {
    console.error("⚠️ Missing STRIPE_WEBHOOK_SECRET");
    return res.status(500).send("Webhook not configured");
  }

  const sig = req.headers["stripe-signature"];

  let event;
  try {
    // req.body is RAW Buffer because index.js uses express.raw()
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

        const sub = await stripe.subscriptions.retrieve(subscriptionId, {
          expand: ["items.data.price"],
        });

        const status = sub.status;
        const currentPeriodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : undefined;

        const extracted = extractEntitlementsFromSubscription(sub);

        const set = {
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
          subscriptionStatus: status || "active",
          currentPeriodEnd,
          isSubscribed: isActiveStatus(status),

          // PLUS add-on entitlement
          extraProfilesQty: Number.isFinite(extracted.extraProfilesQty) ? extracted.extraProfilesQty : 0,
        };

        // Only set plan fields if known
        if (extracted.plan) set.plan = extracted.plan;
        if (extracted.interval) set.planInterval = extracted.interval;

        // TEAMS entitlement fields
        if (extracted.plan === "teams") {
          set.teamsProfilesQty = Math.max(1, Number(extracted.teamsProfilesQty || 1));
          if (extracted.teamsStripeItemId) set.teamsStripeItemId = extracted.teamsStripeItemId;
          if (extracted.teamsStripePriceId) set.teamsStripePriceId = extracted.teamsStripePriceId;
        } else {
          // not teams => normalize teams fields
          set.teamsProfilesQty = 1;
        }

        // If now subscribed, clear trial
        const unset = isActiveStatus(status)
          ? { trialExpires: "" }
          : {};

        if (extracted.plan !== "teams") {
          // clear teams stripe metadata if not teams
          unset.teamsStripeItemId = "";
          unset.teamsStripePriceId = "";
        }

        if (userId) await updateUserById(userId, { set, unset });
        else await updateUserByCustomer(customerId, { set, unset });
      }

      // B) One-time payment checkout (NFC cards)
      if (session.mode === "payment") {
        const customerEmail = session.customer_details?.email;
        const amountPaid = session.amount_total ? (session.amount_total / 100).toFixed(2) : null;

        await sendEmail(
          process.env.EMAIL_USER,
          amountPaid ? `New Konar Card Order - £${amountPaid}` : `New Konar Card Order`,
          `<p>New order from: ${customerEmail || "Unknown email"}</p>${amountPaid ? `<p>Total: £${amountPaid}</p>` : ""}`
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
    // customer.subscription.created / updated
    // -------------------------
    if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
      const sub = event.data.object;

      const customerId = sub.customer;
      const subscriptionId = sub.id;
      const status = sub.status;
      const currentPeriodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : undefined;

      // Retrieve expanded so we can read price ids + quantities
      const fullSub = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ["items.data.price"],
      });

      const extracted = extractEntitlementsFromSubscription(fullSub);

      const set = {
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: status || "active",
        currentPeriodEnd,
        isSubscribed: isActiveStatus(status),

        extraProfilesQty: Number.isFinite(extracted.extraProfilesQty) ? extracted.extraProfilesQty : 0,
      };

      if (extracted.plan) set.plan = extracted.plan;
      if (extracted.interval) set.planInterval = extracted.interval;

      if (extracted.plan === "teams") {
        set.teamsProfilesQty = Math.max(1, Number(extracted.teamsProfilesQty || 1));
        if (extracted.teamsStripeItemId) set.teamsStripeItemId = extracted.teamsStripeItemId;
        if (extracted.teamsStripePriceId) set.teamsStripePriceId = extracted.teamsStripePriceId;
      } else {
        set.teamsProfilesQty = 1;
      }

      const unset = isActiveStatus(status) ? { trialExpires: "" } : {};
      if (extracted.plan !== "teams") {
        unset.teamsStripeItemId = "";
        unset.teamsStripePriceId = "";
      }

      await updateUserByCustomer(customerId, { set, unset });
    }

    // -------------------------
    // invoice.paid
    // -------------------------
    if (event.type === "invoice.paid") {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      const subscriptionId = invoice.subscription;

      let extracted = { plan: null, interval: null, extraProfilesQty: 0, teamsProfilesQty: 1 };

      if (subscriptionId) {
        try {
          const fullSub = await stripe.subscriptions.retrieve(subscriptionId, {
            expand: ["items.data.price"],
          });
          extracted = extractEntitlementsFromSubscription(fullSub);
        } catch {
          // ignore; still mark active
        }
      }

      const set = {
        stripeSubscriptionId: subscriptionId || undefined,
        subscriptionStatus: "active",
        isSubscribed: true,
        extraProfilesQty: Number.isFinite(extracted.extraProfilesQty) ? extracted.extraProfilesQty : 0,
      };

      if (extracted.plan) set.plan = extracted.plan;
      if (extracted.interval) set.planInterval = extracted.interval;

      if (extracted.plan === "teams") {
        set.teamsProfilesQty = Math.max(1, Number(extracted.teamsProfilesQty || 1));
      } else {
        set.teamsProfilesQty = 1;
      }

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

          // reset teams entitlement
          teamsProfilesQty: 1,
        },
        unset: {
          currentPeriodEnd: "",
          stripeSubscriptionId: "",
          teamsStripeItemId: "",
          teamsStripePriceId: "",
        },
      });
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook handler error:", err);
    return res.status(500).send("Webhook handler failed");
  }
};
