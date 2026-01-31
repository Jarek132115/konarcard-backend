// backend/routes/webHook.js
const express = require("express");
const router = express.Router();
const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const User = require("../models/user");

const sendEmail = require("../utils/SendEmail");
const { orderConfirmationTemplate } = require("../utils/emailTemplates");

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Map Stripe price IDs -> your internal plan + interval
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

function isActiveStatus(status) {
  return status === "active" || status === "trialing";
}

function parsePlanKey(planKey) {
  const [p, i] = String(planKey || "").split("-");
  const plan = ["plus", "teams"].includes(p) ? p : null;
  const interval = ["monthly", "quarterly", "yearly"].includes(i) ? i : null;
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

// IMPORTANT: express.raw must be used for Stripe signature verification
router.post(
  "/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
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

          // Retrieve subscription so we can read price + status + period end
          const sub = await stripe.subscriptions.retrieve(subscriptionId, {
            expand: ["items.data.price"],
          });

          const status = sub.status;
          const currentPeriodEnd = sub.current_period_end
            ? new Date(sub.current_period_end * 1000)
            : null;

          const priceId = sub.items?.data?.[0]?.price?.id;
          const mapped = PRICE_TO_PLAN[priceId];

          let plan = mapped?.plan || null;
          let interval = mapped?.interval || null;

          // fallback to planKey metadata if mapping missing
          if ((!plan || !interval) && session.metadata?.planKey) {
            const parsed = parsePlanKey(session.metadata.planKey);
            plan = plan || parsed.plan;
            interval = interval || parsed.interval;
          }

          const set = {
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId,
            plan: plan || "free",
            planInterval: interval || "monthly",
            subscriptionStatus: status || "active",
            currentPeriodEnd: currentPeriodEnd || undefined,
            isSubscribed: isActiveStatus(status),
          };

          if (userId) {
            await updateUserById(userId, { set });
          } else {
            // fallback update by customer (works if user already has stripeCustomerId)
            await updateUserByCustomer(customerId, { set });
          }
        }

        // B) NFC card payment checkout (keep your email logic)
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
      // customer.subscription.updated
      // -------------------------
      if (event.type === "customer.subscription.updated") {
        const sub = event.data.object;

        const customerId = sub.customer;
        const subscriptionId = sub.id;
        const status = sub.status;
        const currentPeriodEnd = sub.current_period_end
          ? new Date(sub.current_period_end * 1000)
          : null;

        const priceId = sub.items?.data?.[0]?.price?.id;
        const mapped = PRICE_TO_PLAN[priceId];

        await updateUserByCustomer(customerId, {
          set: {
            stripeSubscriptionId: subscriptionId,
            plan: mapped?.plan || "free",
            planInterval: mapped?.interval || "monthly",
            subscriptionStatus: status || "active",
            currentPeriodEnd: currentPeriodEnd || undefined,
            isSubscribed: isActiveStatus(status),
          },
        });
      }

      // -------------------------
      // invoice.paid (keeps status accurate)
      // -------------------------
      if (event.type === "invoice.paid") {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const subscriptionId = invoice.subscription;

        // invoice doesn't always include price mapping cleanly,
        // but we can still mark active if Stripe considers it paid
        await updateUserByCustomer(customerId, {
          set: {
            stripeSubscriptionId: subscriptionId || undefined,
            subscriptionStatus: "active",
            isSubscribed: true,
          },
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
            subscriptionStatus: "canceled",
            isSubscribed: false,
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
  }
);

module.exports = router;
