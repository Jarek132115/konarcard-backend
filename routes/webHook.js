// Backend/routes/webHook.js
const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const User = require('../models/user');

const sendEmail = require('../utils/SendEmail');
const { orderConfirmationTemplate } = require('../utils/emailTemplates');

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Map Stripe price IDs -> your internal plan + interval
// (so webhook can determine what the user bought)
const PRICE_TO_PLAN = {
  // PLUS
  [process.env.STRIPE_PRICE_PLUS_MONTHLY]: { plan: 'plus', interval: 'monthly' },
  [process.env.STRIPE_PRICE_PLUS_QUARTERLY]: { plan: 'plus', interval: 'quarterly' },
  [process.env.STRIPE_PRICE_PLUS_YEARLY]: { plan: 'plus', interval: 'yearly' },

  // TEAMS
  [process.env.STRIPE_PRICE_TEAMS_MONTHLY]: { plan: 'teams', interval: 'monthly' },
  [process.env.STRIPE_PRICE_TEAMS_QUARTERLY]: { plan: 'teams', interval: 'quarterly' },
  [process.env.STRIPE_PRICE_TEAMS_YEARLY]: { plan: 'teams', interval: 'yearly' },
};

// Helper: safely update user for subscription state
async function setUserSubscriptionByCustomer(customerId, update) {
  if (!customerId) return;

  await User.findOneAndUpdate(
    { stripeCustomerId: customerId },
    { $set: update },
    { new: true }
  );
}

// IMPORTANT: express.raw must be used for Stripe signature verification
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('⚠️ Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // -------------------------
    // 1) Checkout Completed
    // -------------------------
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      // A) If it's a subscription checkout, update the user's plan in DB
      if (session.mode === 'subscription') {
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        // We stored userId + planKey in metadata when creating the checkout session (we will implement next)
        const userId = session.metadata?.userId;

        // Get the subscription so we can read:
        // - price
        // - status
        // - current_period_end
        const sub = await stripe.subscriptions.retrieve(subscriptionId, {
          expand: ['items.data.price'],
        });

        const status = sub.status;
        const currentPeriodEnd = sub.current_period_end
          ? new Date(sub.current_period_end * 1000)
          : undefined;

        // Determine plan + interval from the subscription's first item price id
        const priceId = sub.items?.data?.[0]?.price?.id;
        const mapped = PRICE_TO_PLAN[priceId];

        if (!mapped) {
          console.warn('[Stripe webhook] Unknown subscription price id:', priceId);
        }

        // Prefer mapping, but if missing, fallback to parsing planKey from metadata
        let plan = mapped?.plan || null;
        let interval = mapped?.interval || null;

        const planKey = session.metadata?.planKey; // e.g. "plus-monthly"
        if ((!plan || !interval) && planKey) {
          const [p, i] = String(planKey).split('-');
          if (['plus', 'teams'].includes(p)) plan = p;
          if (['monthly', 'quarterly', 'yearly'].includes(i)) interval = i;
        }

        // If we have userId, update by _id (best)
        if (userId) {
          await User.findByIdAndUpdate(
            userId,
            {
              $set: {
                stripeCustomerId: customerId,
                stripeSubscriptionId: subscriptionId,
                plan: plan || 'free',
                planInterval: interval || 'monthly',
                subscriptionStatus: status || 'active',
                currentPeriodEnd,
                isSubscribed: status === 'active' || status === 'trialing',
              },
            },
            { new: true }
          );
        } else {
          // Fallback: if no userId stored, update via customer id
          // (works if stripeCustomerId already exists on user)
          await setUserSubscriptionByCustomer(customerId, {
            stripeSubscriptionId: subscriptionId,
            plan: plan || 'free',
            planInterval: interval || 'monthly',
            subscriptionStatus: status || 'active',
            currentPeriodEnd,
            isSubscribed: status === 'active' || status === 'trialing',
          });
        }
      }

      // B) If it's a payment checkout (your NFC card orders), keep your existing email logic
      if (session.mode === 'payment') {
        const customerEmail = session.customer_details?.email;
        const amountPaid = session.amount_total ? (session.amount_total / 100).toFixed(2) : null;

        // Email you
        await sendEmail(
          process.env.EMAIL_USER,
          amountPaid
            ? `New Konar Card Order - £${amountPaid}`
            : `New Konar Card Order`,
          `<p>New order from: ${customerEmail || 'Unknown email'}</p>${amountPaid ? `<p>Total: £${amountPaid}</p>` : ''
          }`
        );

        // Email customer
        if (customerEmail && amountPaid) {
          await sendEmail(
            customerEmail,
            'Your Konar Card Order Confirmation',
            orderConfirmationTemplate(customerEmail, amountPaid)
          );
        }
      }
    }

    // -------------------------
    // 2) Subscription Updated
    // -------------------------
    if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;

      const customerId = sub.customer;
      const subscriptionId = sub.id;
      const status = sub.status;
      const currentPeriodEnd = sub.current_period_end
        ? new Date(sub.current_period_end * 1000)
        : undefined;

      const priceId = sub.items?.data?.[0]?.price?.id;
      const mapped = PRICE_TO_PLAN[priceId];

      await setUserSubscriptionByCustomer(customerId, {
        stripeSubscriptionId: subscriptionId,
        plan: mapped?.plan || 'free',
        planInterval: mapped?.interval || 'monthly',
        subscriptionStatus: status || 'active',
        currentPeriodEnd,
        isSubscribed: status === 'active' || status === 'trialing',
      });
    }

    // -------------------------
    // 3) Subscription Deleted (Canceled)
    // -------------------------
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const customerId = sub.customer;

      // When canceled/deleted, send user back to free
      await setUserSubscriptionByCustomer(customerId, {
        plan: 'free',
        subscriptionStatus: 'canceled',
        isSubscribed: false,
        currentPeriodEnd: undefined,
        stripeSubscriptionId: undefined,
      });
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).send('Webhook handler failed');
  }
});

module.exports = router;
