// backend/routes/webHook.js
// IMPORTANT: Stripe webhooks REQUIRE the raw body.
// In your main server file you must mount like:
//
//   app.post(
//     "/api/checkout/webhook",
//     express.raw({ type: "application/json" }),
//     require("./routes/webHook")
//   );
//
// And DO NOT run express.json() on that route.

const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const QRCode = require("qrcode");

const User = require("../models/user");
const BusinessCard = require("../models/BusinessCard");
const NfcOrder = require("../models/NfcOrder");

const uploadToS3 = require("../utils/uploadToS3");

const sendEmail = require("../utils/SendEmail");
const {
    orderConfirmationTemplate,
    orderNotificationAdminTemplate,
    subscriptionStartedTemplate,
    paymentFailedTemplate,
} = require("../utils/emailTemplates");

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

const PUBLIC_PROFILE_DOMAIN =
  process.env.PUBLIC_PROFILE_DOMAIN || "https://www.konarcard.com";

/**
 * Price mapping (base subscription)
 */
const PRICE_TO_PLAN = {
  [process.env.STRIPE_PRICE_PLUS_MONTHLY]: { plan: "plus", interval: "monthly" },
  [process.env.STRIPE_PRICE_PLUS_QUARTERLY]: { plan: "plus", interval: "quarterly" },
  [process.env.STRIPE_PRICE_PLUS_YEARLY]: { plan: "plus", interval: "yearly" },

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

function cleanString(v, max = 2000) {
  return String(v || "").trim().slice(0, max);
}

function cleanLower(v, max = 240) {
  return cleanString(v, max).toLowerCase();
}

function safeProfileSlug(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
}

function buildPublicUrlBySlug(profileSlug) {
  const s = safeProfileSlug(profileSlug);
  if (!s) return "";
  return `${PUBLIC_PROFILE_DOMAIN}/u/${s}`;
}

function buildTrackedUrlBySlug(profileSlug, via = "") {
  const base = buildPublicUrlBySlug(profileSlug);
  const cleanVia = cleanLower(via, 20);

  if (!base) return "";
  if (!cleanVia) return base;

  if (!["qr", "nfc"].includes(cleanVia)) return base;
  return `${base}?via=${encodeURIComponent(cleanVia)}`;
}

function buildAddressString(address) {
  if (!address || typeof address !== "object") return "";

  return [
    cleanString(address.line1, 120),
    cleanString(address.line2, 120),
    cleanString(address.city, 120),
    cleanString(address.state, 120),
    cleanString(address.postal_code, 60),
    cleanString(address.country, 60),
  ]
    .filter(Boolean)
    .join(", ");
}

function normalizeShippingPayload(shippingDetails, customerDetails = {}) {
  const shippingObj =
    shippingDetails && typeof shippingDetails === "object" ? shippingDetails : {};
  const customerObj =
    customerDetails && typeof customerDetails === "object" ? customerDetails : {};

  const shippingAddress =
    shippingObj.address && typeof shippingObj.address === "object"
      ? shippingObj.address
      : null;

  const customerAddress =
    customerObj.address && typeof customerObj.address === "object"
      ? customerObj.address
      : null;

  const chosenAddress = shippingAddress || customerAddress || {};

  return {
    name: cleanString(shippingObj.name || customerObj.name, 160),
    phone: cleanString(shippingObj.phone || customerObj.phone, 60),
    address: {
      line1: cleanString(chosenAddress.line1, 120),
      line2: cleanString(chosenAddress.line2, 120),
      city: cleanString(chosenAddress.city, 120),
      state: cleanString(chosenAddress.state, 120),
      postal_code: cleanString(chosenAddress.postal_code, 60),
      country: cleanString(chosenAddress.country, 60),
    },
  };
}

function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function addWorkingDays(dateLike, daysToAdd) {
  const d = new Date(dateLike);
  d.setHours(12, 0, 0, 0);

  let added = 0;
  while (added < daysToAdd) {
    d.setDate(d.getDate() + 1);
    if (!isWeekend(d)) {
      added += 1;
    }
  }

  return d;
}

function formatEstimatedDeliveryDate(date) {
  return date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function getInitialEstimatedDelivery(now = new Date()) {
  const beforeCutoff = now.getHours() < 13;

  const deliveryDate = beforeCutoff
    ? addWorkingDays(now, 1)
    : addWorkingDays(now, 2);

  return {
    label: formatEstimatedDeliveryDate(deliveryDate),
    helper: beforeCutoff
      ? "Same-day shipping when you order before 1pm."
      : "Orders after 1pm ship next working day.",
  };
}

async function updateUserByCustomer(customerId, { set = {}, unset = {} }) {
  if (!customerId) return null;

  const update = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;
  if (!Object.keys(update).length) return null;

  return User.findOneAndUpdate({ stripeCustomerId: customerId }, update, {
    new: true,
  });
}

async function updateUserById(userId, { set = {}, unset = {} }) {
  if (!userId) return null;

  const update = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;
  if (!Object.keys(update).length) return null;

  return User.findByIdAndUpdate(userId, update, { new: true });
}

async function findUserIdByCustomer(customerId) {
  if (!customerId) return null;
  const u = await User.findOne({ stripeCustomerId: customerId }).select("_id username");
  if (!u) return null;
  return { userId: String(u._id), username: u.username || "" };
}

/**
 * Extract entitlements from subscription (expanded with items.data.price)
 * Teams allowed profiles = 1 + extraProfilesQty
 */
function extractEntitlementsFromSubscription(sub) {
  const items = Array.isArray(sub?.items?.data) ? sub.items.data : [];

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

  let extraProfilesQty = 0;
  for (const it of items) {
    const priceId = it?.price?.id;
    if (priceId && EXTRA_PROFILE_PRICE_IDS.includes(priceId)) {
      extraProfilesQty += Number(it?.quantity || 0);
    }
  }

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
  if (!slug || slug.length < 3) {
    return { created: false, reason: "invalid_slug" };
  }

  const existing = await BusinessCard.findOne({ profile_slug: slug }).select("_id");
  if (existing) return { created: false, reason: "already_exists" };

  const publicUrl = buildPublicUrlBySlug(slug);
  const qrTargetUrl = buildTrackedUrlBySlug(slug, "qr");

  let qrUrl = "";
  try {
    const pngBuffer = await QRCode.toBuffer(qrTargetUrl || publicUrl, {
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
    business_name: "",
    trade_title: "",
    location: "",
    full_name: "",
    qr_code_url: qrUrl,
  });

  try {
    const user = await User.findById(userId).select("qrCodeUrl profileUrl slug username");
    if (user) {
      const patch = {};
      if (!user.qrCodeUrl && qrUrl) patch.qrCodeUrl = qrUrl;
      if (!user.profileUrl) patch.profileUrl = publicUrl;
      if (!user.slug) patch.slug = slug;
      if (!user.username) patch.username = slug;

      if (Object.keys(patch).length) {
        await User.findByIdAndUpdate(userId, { $set: patch }, { new: true });
      }
    }
  } catch (e) {
    console.warn("ensureClaimedProfile user patch failed:", e?.message || e);
  }

  return { created: true, id: created?._id, slug, qrUrl };
}

/**
 * NFC order updater
 * Status model:
 * - pending: created but not yet confirmed paid
 * - paid: Stripe successfully paid
 * - failed: payment failed
 * - cancelled: checkout expired / manually cancelled in app flow
 * - fulfilled: later physical fulfilment step
 */
async function updateNfcOrderFromSession(session, statusOverride) {
  const checkoutType = session?.metadata?.checkoutType;
  if (checkoutType !== "nfc_order") return null;

  const orderId = session?.metadata?.orderId ? String(session.metadata.orderId) : "";
  if (!orderId) return null;

  const paymentStatus = String(session.payment_status || "").toLowerCase();

  let nextStatus = "pending";
  if (statusOverride) {
    nextStatus = statusOverride;
  } else if (paymentStatus === "paid" || paymentStatus === "no_payment_required") {
    nextStatus = "paid";
  }

  const amountTotal = Number(session.amount_total || 0);
  const currency = cleanLower(session.currency || "gbp", 12) || "gbp";
  const paymentIntentId = session.payment_intent ? String(session.payment_intent) : "";

  const productKey = cleanString(session?.metadata?.productKey, 120);
  const variant = cleanString(session?.metadata?.variant, 120);
  const family = cleanString(session?.metadata?.family, 120);
  const edition = cleanString(session?.metadata?.edition, 120);
  const logoUrl = cleanString(session?.metadata?.logoUrl, 1200);
  const previewImageUrl = cleanString(session?.metadata?.previewImageUrl, 1200);
  const quantityMeta = session?.metadata?.quantity ? Number(session.metadata.quantity) : null;
  const profileId = cleanString(session?.metadata?.profileId, 120);
  const profileSlug = cleanString(session?.metadata?.profileSlug, 120);
  const deliveryWindowMeta = cleanString(session?.metadata?.deliveryWindow, 160);

  let publicProfileUrl = cleanString(session?.metadata?.publicProfileUrl, 1200);
  let qrTargetUrl = cleanString(session?.metadata?.qrTargetUrl, 1200);
  let nfcTargetUrl = cleanString(session?.metadata?.nfcTargetUrl, 1200);

  const frontText = cleanString(session?.metadata?.frontText, 240);
  const fontFamily = cleanString(session?.metadata?.fontFamily, 120);
  const fontWeight = session?.metadata?.fontWeight ? Number(session.metadata.fontWeight) : null;
  const fontSize = session?.metadata?.fontSize ? Number(session.metadata.fontSize) : null;
  const orientation = cleanString(session?.metadata?.orientation, 80);
  const textColor = cleanString(session?.metadata?.textColor, 80);

  const styleKey = cleanString(session?.metadata?.styleKey, 120);
  const frontTemplate = cleanString(session?.metadata?.frontTemplate, 120);
  const backTemplate = cleanString(session?.metadata?.backTemplate, 120);
  const usesPresetArtwork = session?.metadata?.usesPresetArtwork === "true";

  const customerDetails =
    session?.customer_details && typeof session.customer_details === "object"
      ? session.customer_details
      : {};

  const shippingDetails =
    session?.shipping_details && typeof session.shipping_details === "object"
      ? session.shipping_details
      : {};

  const customerName = cleanString(
    customerDetails.name || shippingDetails.name || "",
    160
  );
  const customerEmail = cleanLower(customerDetails.email || "", 240);
  const deliveryName = cleanString(
    shippingDetails.name || customerDetails.name || "",
    160
  );

  const shippingPayload = normalizeShippingPayload(shippingDetails, customerDetails);
  const deliveryAddress = buildAddressString(shippingPayload.address);

  const existing = await NfcOrder.findById(orderId).select(
    "_id status preview profile qrCodeUrl publicProfileUrl qrTargetUrl nfcTargetUrl deliveryWindow"
  );
  if (!existing) return null;

  let qrCodeUrl = cleanString(existing?.qrCodeUrl, 1200);

  let resolvedProfileSlug = safeProfileSlug(
    profileSlug || existing?.preview?.profileSlug || ""
  );

  if (!resolvedProfileSlug && existing.profile) {
    const profileDoc = await BusinessCard.findById(existing.profile)
      .select("_id qr_code_url profile_slug")
      .lean();

    if (profileDoc?.profile_slug) {
      resolvedProfileSlug = safeProfileSlug(profileDoc.profile_slug);
    }

    if (!qrCodeUrl && profileDoc?.qr_code_url) {
      qrCodeUrl = cleanString(profileDoc.qr_code_url, 1200);
    }
  } else if (!qrCodeUrl && profileId) {
    const profileDoc = await BusinessCard.findById(profileId)
      .select("_id qr_code_url profile_slug")
      .lean();

    if (profileDoc?.profile_slug && !resolvedProfileSlug) {
      resolvedProfileSlug = safeProfileSlug(profileDoc.profile_slug);
    }

    if (profileDoc?.qr_code_url) {
      qrCodeUrl = cleanString(profileDoc.qr_code_url, 1200);
    }
  }

  if (!publicProfileUrl && resolvedProfileSlug) {
    publicProfileUrl = buildPublicUrlBySlug(resolvedProfileSlug);
  }

  if (!qrTargetUrl && resolvedProfileSlug) {
    qrTargetUrl = buildTrackedUrlBySlug(resolvedProfileSlug, "qr");
  }

  if (!nfcTargetUrl && resolvedProfileSlug) {
    nfcTargetUrl = buildTrackedUrlBySlug(resolvedProfileSlug, "nfc");
  }

  if (existing.status === "fulfilled") {
    await NfcOrder.findByIdAndUpdate(orderId, {
      $set: {
        stripeCheckoutSessionId: String(session.id || ""),
        ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
        ...(customerName ? { customerName } : {}),
        ...(customerEmail ? { customerEmail } : {}),
        ...(deliveryName ? { deliveryName } : {}),
        ...(deliveryAddress ? { deliveryAddress } : {}),
        ...(Object.keys(shippingPayload).length ? { shipping: shippingPayload } : {}),
        ...(qrCodeUrl ? { qrCodeUrl } : {}),
        ...(publicProfileUrl ? { publicProfileUrl } : {}),
        ...(qrTargetUrl ? { qrTargetUrl } : {}),
        ...(nfcTargetUrl ? { nfcTargetUrl } : {}),
      },
    });
    return null;
  }

  const prevPreview =
    existing.preview && typeof existing.preview === "object" ? existing.preview : {};
  const prevCustomization =
    prevPreview.customization && typeof prevPreview.customization === "object"
      ? prevPreview.customization
      : {};

  const mergedCustomization = {
    ...prevCustomization,
    ...(frontText ? { frontText } : {}),
    ...(fontFamily ? { fontFamily } : {}),
    ...(Number.isFinite(fontWeight) && fontWeight > 0 ? { fontWeight } : {}),
    ...(Number.isFinite(fontSize) && fontSize > 0 ? { fontSize } : {}),
    ...(orientation ? { orientation } : {}),
    ...(textColor ? { textColor } : {}),
  };

  const mergedPreview = {
    ...prevPreview,
    ...(variant ? { variant } : {}),
    ...(family ? { family } : {}),
    ...(edition ? { edition } : {}),
    ...(resolvedProfileSlug ? { profileSlug: resolvedProfileSlug } : {}),
    ...(publicProfileUrl ? { publicProfileUrl } : {}),
    ...(qrTargetUrl ? { qrTargetUrl } : {}),
    ...(nfcTargetUrl ? { nfcTargetUrl } : {}),
    ...(styleKey ? { styleKey } : {}),
    ...(frontTemplate ? { frontTemplate } : {}),
    ...(backTemplate ? { backTemplate } : {}),
    ...(session?.metadata?.usesPresetArtwork ? { usesPresetArtwork } : {}),
    ...(Object.keys(mergedCustomization).length
      ? { customization: mergedCustomization }
      : {}),
  };

  const safeQtyMeta = Number.isFinite(quantityMeta) ? quantityMeta : undefined;
  const estimatedDelivery = getInitialEstimatedDelivery();

  const updated = await NfcOrder.findByIdAndUpdate(
    orderId,
    {
      $set: {
        status: nextStatus,
        amountTotal: Number.isFinite(amountTotal) ? amountTotal : 0,
        currency: currency || "gbp",
        stripeCheckoutSessionId: String(session.id || ""),
        ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
        ...(logoUrl ? { logoUrl } : {}),
        ...(previewImageUrl ? { previewImageUrl } : {}),
        ...(productKey ? { productKey } : {}),
        ...(variant ? { variant } : {}),
        ...(profileId ? { profile: profileId } : {}),
        ...(customerName ? { customerName } : {}),
        ...(customerEmail ? { customerEmail } : {}),
        ...(deliveryName ? { deliveryName } : {}),
        ...(deliveryAddress ? { deliveryAddress } : {}),
        ...(Object.keys(shippingPayload).length ? { shipping: shippingPayload } : {}),
        ...(qrCodeUrl ? { qrCodeUrl } : {}),
        ...(publicProfileUrl ? { publicProfileUrl } : {}),
        ...(qrTargetUrl ? { qrTargetUrl } : {}),
        ...(nfcTargetUrl ? { nfcTargetUrl } : {}),
        ...(existing.deliveryWindow
          ? {}
          : {
            deliveryWindow: deliveryWindowMeta || estimatedDelivery.label,
          }),
        preview: mergedPreview,
        ...(safeQtyMeta ? { quantity: safeQtyMeta } : {}),
      },
    },
    { new: true }
  );

  return updated;
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
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

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
          extraProfilesQty: Number.isFinite(extracted.extraProfilesQty)
            ? extracted.extraProfilesQty
            : 0,
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

        if (checkoutType === "teams_add_profile" && claimedSlug) {
          let resolved = { userId: metaUserId };

          if (!resolved.userId) {
            const found = await findUserIdByCustomer(customerId);
            if (found) resolved.userId = found.userId;
          }

          if (resolved.userId) {
            await ensureClaimedProfile({ userId: resolved.userId, claimedSlug });
          } else {
            console.warn("⚠️ Could not resolve userId for claimed profile creation");
          }
        }
      }

      if (session.mode === "payment") {
        await updateNfcOrderFromSession(session);

        try {
          const customerEmail = cleanLower(session.customer_details?.email || "", 240);
          const customerName = cleanString(session.customer_details?.name || "", 160);

          const productKey = cleanString(session.metadata?.productKey, 120);
          const variant = cleanString(session.metadata?.variant, 120);
          const qtyMeta = session.metadata?.quantity
            ? Number(session.metadata.quantity)
            : null;
          const frontText = cleanString(session.metadata?.frontText, 240);

          const amountTotal = Number(session.amount_total || 0);
          const amountPaid = amountTotal ? (amountTotal / 100).toFixed(2) : null;

          console.log("[webhook] Sending order emails", { customerEmail, amountPaid, productKey });

          if (process.env.EMAIL_USER) {
            try {
              await sendEmail(
                process.env.EMAIL_USER,
                amountPaid ? `New Konar Order - £${amountPaid}` : "New Konar Order",
                orderNotificationAdminTemplate(customerName, customerEmail, productKey, variant, qtyMeta, amountPaid)
              );
              console.log("[webhook] Admin notification email sent to", process.env.EMAIL_USER);
            } catch (adminErr) {
              console.error("[webhook] Admin notification email FAILED:", adminErr?.message || adminErr);
            }
          } else {
            console.warn("[webhook] EMAIL_USER not set — skipping admin notification");
          }

          if (customerEmail) {
            try {
              await sendEmail(
                customerEmail,
                "Your KonarCard Order Confirmation",
                orderConfirmationTemplate(customerName || customerEmail, amountPaid || "0.00")
              );
              console.log("[webhook] Customer confirmation email sent to", customerEmail);
            } catch (custErr) {
              console.error("[webhook] Customer confirmation email FAILED:", custErr?.message || custErr);
            }
          } else {
            console.warn("[webhook] No customer email on session — skipping customer confirmation");
          }
        } catch (e) {
          console.error("[webhook] Email block error:", e?.message || e);
        }

        return res.status(200).send("OK");
      }
    }

    if (event.type === "checkout.session.async_payment_failed") {
      const session = event.data.object;
      await updateNfcOrderFromSession(session, "failed");
    }

    if (event.type === "checkout.session.expired") {
      const session = event.data.object;
      await updateNfcOrderFromSession(session, "cancelled");
    }

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
        extraProfilesQty: Number.isFinite(extracted.extraProfilesQty)
          ? extracted.extraProfilesQty
          : 0,
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

      // Send subscription welcome email on first creation only
      if (event.type === "customer.subscription.created" && isActiveStatus(status)) {
        try {
          const subUser = await User.findOne({ stripeCustomerId: customerId });
          if (subUser?.email) {
            sendEmail(
              subUser.email,
              "Your KonarCard subscription is active!",
              subscriptionStartedTemplate(subUser.name, extracted.plan, extracted.interval)
            ).catch((err) => console.error("Subscription started email failed:", err));
          }
        } catch (e) {
          console.warn("Subscription email lookup failed:", e?.message);
        }
      }
    }

    if (event.type === "invoice.paid") {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      const subscriptionId = invoice.subscription;

      let extracted = {
        plan: null,
        interval: null,
        extraProfilesQty: 0,
        teamsProfilesQty: 1,
      };
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
        } catch {
          // ignore
        }
      }

      const set = {
        stripeSubscriptionId: subscriptionId || undefined,
        subscriptionStatus: "active",
        isSubscribed: true,
        currentPeriodEnd,
        extraProfilesQty: Number.isFinite(extracted.extraProfilesQty)
          ? extracted.extraProfilesQty
          : 0,
        teamsProfilesQty:
          extracted.plan === "teams"
            ? Math.max(1, Number(extracted.teamsProfilesQty || 1))
            : 1,
      };

      if (extracted.plan) set.plan = extracted.plan;
      if (extracted.interval) set.planInterval = extracted.interval;

      await updateUserByCustomer(customerId, {
        set,
        unset: { trialExpires: "" },
      });
    }

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

      // Notify user about failed payment
      try {
        const failedUser = await User.findOne({ stripeCustomerId: customerId });
        if (failedUser?.email) {
          sendEmail(
            failedUser.email,
            "Action needed: payment failed",
            paymentFailedTemplate(failedUser.name)
          ).catch((err) => console.error("Payment failed email error:", err));
        }
      } catch (e) {
        console.warn("Payment failed email lookup error:", e?.message);
      }
    }

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