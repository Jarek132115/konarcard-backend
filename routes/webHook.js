// backend/routes/webHook.js
const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const QRCode = require("qrcode");

const User = require("../models/user");
const BusinessCard = require("../models/BusinessCard");
const uploadToS3 = require("../utils/uploadToS3");

const sendEmail = require("../utils/SendEmail");
const { orderConfirmationTemplate } = require("../utils/emailTemplates");

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

const PUBLIC_PROFILE_DOMAIN =
  process.env.PUBLIC_PROFILE_DOMAIN || "https://www.konarcard.com";

/**
 * Price mapping (base subscription)
 */
const PRICE_TO_PLAN = {
  // PLUS
  [process.env.STRIPE_PRICE_PLUS_MONTHLY]: { plan: "plus", interval: "monthly" },
  [process.env.STRIPE_PRICE_PLUS_QUARTERLY]: { plan: "plus", interval: "quarterly" },
  [process.env.STRIPE_PRICE_PLUS_YEARLY]: { plan: "plus", interval: "yearly" },

  // TEAMS (base item)
  [process.env.STRIPE_PRICE_TEAMS_MONTHLY]: { plan: "teams", interval: "monthly" },
  [process.env.STRIPE_PRICE_TEAMS_QUARTERLY]: { plan: "teams", interval: "quarterly" },
  [process.env.STRIPE_PRICE_TEAMS_YEARLY]: { plan: "teams", interval: "yearly" },
};

const EXTRA_PROFILE_PRICE_IDS = [
  process.env.STRIPE_PRICE_EXTRA_PROFILE_MONTHLY,
  process.env.STRIPE_PRICE_EXTRA_PROFILE_QUARTERLY,
  process.env.STRIPE_PRICE_EXTRA_PROFILE_YEARLY,
].filter(Boolean);

function isActiveStatus(status) {
  return status === "active" || status === "trialing";
}

function safeProfileSlug(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
}

async function updateUserByCustomer(customerId, { set = {}, unset = {} }) {
  if (!customerId) return;

  const update = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;
  if (!Object.keys(update).length) return;

  await User.findOneAndUpdate({ stripeCustomerId: customerId }, update, { new: true });
}

async function updateUserById(userId, { set = {}, unset = {} }) {
  if (!userId) return;

  const update = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;
  if (!Object.keys(update).length) return;

  await User.findByIdAndUpdate(userId, update, { new: true });
}

async function findUserIdByCustomer(customerId) {
  if (!customerId) return null;
  const u = await User.findOne({ stripeCustomerId: customerId }).select("_id username");
  if (!u) return null;
  return { userId: String(u._id), username: u.username || "" };
}

function buildPublicUrlBySlug(profileSlug) {
  const s = safeProfileSlug(profileSlug);
  if (!s) return "";
  return `${PUBLIC_PROFILE_DOMAIN}/u/${s}`;
}

/**
 * Extract entitlements from subscription (expanded with items.data.price)
 *
 * Teams allowed profiles = 1 (included) + extraProfilesQty
 */
function extractEntitlementsFromSubscription(sub) {
  const items = Array.isArray(sub?.items?.data) ? sub.items.data : [];

  // Base plan
  let plan = null;
  let interval = null;

  let teamsStripeItemId;
  let teamsStripePriceId;

  for (const it of items) {
    const priceId = it?.price?.id;
    const mapped = priceId ? PRICE_TO_PLAN[priceId] : null;
    if (mapped?.plan && mapped?.interval) {
      plan = mapped.plan;
      interval = mapped.interval;
      if (mapped.plan === "teams") {
        teamsStripeItemId = it.id;
        teamsStripePriceId = priceId;
      }
      break;
    }
  }

  // Extra profiles add-on quantity (sum)
  let extraProfilesQty = 0;
  for (const it of items) {
    const priceId = it?.price?.id;
    if (priceId && EXTRA_PROFILE_PRICE_IDS.includes(priceId)) {
      extraProfilesQty += Number(it?.quantity || 0);
    }
  }

  // Teams total allowed profiles
  const teamsProfilesQty =
    plan === "teams" ? Math.max(1, 1 + Math.max(0, extraProfilesQty)) : 1;

  return {
    plan,
    interval,
    extraProfilesQty,
    teamsProfilesQty,
    teamsStripeItemId,
    teamsStripePriceId,
  };
}

/**
 * Create BusinessCard for claimed slug (idempotent)
 */
async function ensureClaimedProfile({ userId, claimedSlug }) {
  const slug = safeProfileSlug(claimedSlug);
  if (!slug || slug.length < 3) return { created: false, reason: "invalid_slug" };

  const existing = await BusinessCard.findOne({ profile_slug: slug }).select("_id");
  if (existing) return { created: false, reason: "already_exists" };

  const publicUrl = buildPublicUrlBySlug(slug);

  let qrUrl = "";
  try {
    const pngBuffer = await QRCode.toBuffer(publicUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 512,
    });

    const key = `qr-codes/${userId}/${slug}-${Date.now()}.png`;
    qrUrl = await uploadToS3(pngBuffer, key);
  } catch {
    qrUrl = "";
  }

  const created = await BusinessCard.create({
    user: userId,
    profile_slug: slug,
    template_id: "template-1",
    business_card_name: "",
    qr_code_url: qrUrl,
  });

  return { created: true, id: created?._id, slug, qrUrl };
}

module.exports = async function stripeWebhookHandler(req, res) {
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
    // ---------------------------------------
    // checkout.session.completed
    // ---------------------------------------
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      // Subscription
      if (session.mode === "subscription") {
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        const metaUserId = session.metadata?.userId ? String(session.metadata.userId) : null;
        const claimedSlug = session.metadata?.claimedSlug;
        const checkoutType = session.metadata?.checkoutType;

        const sub = await stripe.subscriptions.retrieve(subscriptionId, {
          expand: ["items.data.price"],
        });

        const status = sub.status;
        const currentPeriodEnd = sub.current_period_end
          ? new Date(sub.current_period_end * 1000)
          : undefined;

        const extracted = extractEntitlementsFromSubscription(sub);

        const set = {
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
          subscriptionStatus: status || "active",
          currentPeriodEnd,
          isSubscribed: isActiveStatus(status),
          extraProfilesQty: Number.isFinite(extracted.extraProfilesQty) ? extracted.extraProfilesQty : 0,
          teamsProfilesQty:
            extracted.plan === "teams"
              ? Math.max(1, Number(extracted.teamsProfilesQty || 1))
              : 1,
        };

        if (extracted.plan) set.plan = extracted.plan;
        if (extracted.interval) set.planInterval = extracted.interval;

        if (extracted.plan === "teams") {
          if (extracted.teamsStripeItemId) set.teamsStripeItemId = extracted.teamsStripeItemId;
          if (extracted.teamsStripePriceId) set.teamsStripePriceId = extracted.teamsStripePriceId;
        }

        const unset = isActiveStatus(status) ? { trialExpires: "" } : {};
        if (extracted.plan !== "teams") {
          unset.teamsStripeItemId = "";
          unset.teamsStripePriceId = "";
        }

        if (metaUserId) await updateUserById(metaUserId, { set, unset });
        else await updateUserByCustomer(customerId, { set, unset });

        // Create claimed profile on Teams add flow
        if (checkoutType === "teams_add_profile" && claimedSlug) {
          let resolved = { userId: metaUserId };

          if (!resolved.userId) {
            const found = await findUserIdByCustomer(customerId);
            if (found) resolved.userId = found.userId;
          }

          if (resolved.userId) {
            await ensureClaimedProfile({
              userId: resolved.userId,
              claimedSlug,
            });
          } else {
            console.warn("⚠️ Could not resolve userId for claimed profile creation");
          }
        }
      }

      // One-time payment (NFC)
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

    // ---------------------------------------
    // subscription created / updated
    // ---------------------------------------
    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated"
    ) {
      const subObj = event.data.object;

      const customerId = subObj.customer;
      const subscriptionId = subObj.id;
      const status = subObj.status;
      const currentPeriodEnd = subObj.current_period_end
        ? new Date(subObj.current_period_end * 1000)
        : undefined;

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
        teamsProfilesQty:
          extracted.plan === "teams"
            ? Math.max(1, Number(extracted.teamsProfilesQty || 1))
            : 1,
      };

      if (extracted.plan) set.plan = extracted.plan;
      if (extracted.interval) set.planInterval = extracted.interval;

      if (extracted.plan === "teams") {
        if (extracted.teamsStripeItemId) set.teamsStripeItemId = extracted.teamsStripeItemId;
        if (extracted.teamsStripePriceId) set.teamsStripePriceId = extracted.teamsStripePriceId;
      }

      const unset = isActiveStatus(status) ? { trialExpires: "" } : {};
      if (extracted.plan !== "teams") {
        unset.teamsStripeItemId = "";
        unset.teamsStripePriceId = "";
      }

      await updateUserByCustomer(customerId, { set, unset });
    }

    // ---------------------------------------
    // invoice.paid
    // ✅ FIX: also set currentPeriodEnd from subscription
    // ---------------------------------------
    if (event.type === "invoice.paid") {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      const subscriptionId = invoice.subscription;

      let extracted = { plan: null, interval: null, extraProfilesQty: 0, teamsProfilesQty: 1 };
      let currentPeriodEnd;

      if (subscriptionId) {
        try {
          const fullSub = await stripe.subscriptions.retrieve(subscriptionId, {
            expand: ["items.data.price"],
          });
          extracted = extractEntitlementsFromSubscription(fullSub);

          currentPeriodEnd = fullSub.current_period_end
            ? new Date(fullSub.current_period_end * 1000)
            : undefined;
        } catch { }
      }

      const set = {
        stripeSubscriptionId: subscriptionId || undefined,
        subscriptionStatus: "active",
        isSubscribed: true,
        currentPeriodEnd, // ✅ NOW SAVED
        extraProfilesQty: Number.isFinite(extracted.extraProfilesQty) ? extracted.extraProfilesQty : 0,
        teamsProfilesQty:
          extracted.plan === "teams"
            ? Math.max(1, Number(extracted.teamsProfilesQty || 1))
            : 1,
      };

      if (extracted.plan) set.plan = extracted.plan;
      if (extracted.interval) set.planInterval = extracted.interval;

      await updateUserByCustomer(customerId, { set, unset: { trialExpires: "" } });
    }

    // ---------------------------------------
    // invoice.payment_failed
    // ---------------------------------------
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

    // ---------------------------------------
    // customer.subscription.deleted
    // ---------------------------------------
    if (event.type === "customer.subscription.deleted") {
      const subObj = event.data.object;
      const customerId = subObj.customer;

      await updateUserByCustomer(customerId, {
        set: {
          plan: "free",
          planInterval: "monthly",
          subscriptionStatus: "canceled",
          isSubscribed: false,
          extraProfilesQty: 0,
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
