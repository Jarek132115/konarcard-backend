// backend/routes/stripe.js
const express = require('express');
const router = express.Router();
const Stripe = require('stripe');

const stripeSecret = process.env.STRIPE_SECRET_KEY;
if (!stripeSecret) {
  console.warn('[stripe] STRIPE_SECRET_KEY is not set. Webhook will not work.');
}
const stripe = stripeSecret ? new Stripe(stripeSecret, { apiVersion: '2024-06-20' }) : null;

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET; // set this in Cloud Run (from Stripe dashboard)
const CLIENT_URL = (process.env.CLIENT_URL || 'https://www.konarcard.com').replace(/\/+$/, '');

const Order = require('../models/Order');
const User = require('../models/user');
const sendEmail = require('../utils/SendEmail');

// ---------- helpers ----------
function htmlEmail({ headline, bodyHtml, ctaLabel, ctaUrl }) {
  return `
    <div style="font-family:Arial,Helvetica,sans-serif; color:#222;">
      <h2 style="margin:0 0 8px;">${headline}</h2>
      <div style="line-height:1.6; font-size:15px;">${bodyHtml}</div>
      ${ctaUrl ? `
        <div style="margin:18px 0;">
          <a href="${ctaUrl}" style="display:inline-block; padding:10px 16px; background:#111; color:#fff; text-decoration:none; border-radius:10px; font-weight:700;">
            ${ctaLabel || 'View your order'}
          </a>
        </div>` : ''}
    </div>
  `;
}

function formatAddress(addr = {}) {
  // Stripe returns { line1, line2, city, state, postal_code, country }
  const parts = [
    addr.line1,
    addr.line2,
    [addr.city, addr.state].filter(Boolean).join(', '),
    addr.postal_code,
    addr.country,
  ].filter(Boolean);
  return parts.join(', ');
}

// Derive deliveryName + deliveryAddress from session
function shippingFromSession(session) {
  // Prefer shipping_details (if you enabled shipping address collection)
  const ship = session.shipping_details || {};
  const cust = session.customer_details || {};
  const name = (ship.name || cust.name || '').trim();

  const addr = ship.address || cust.address || {};
  const addressOneLine = formatAddress(addr);

  return {
    deliveryName: name || null,
    deliveryAddress: addressOneLine || null,
  };
}

// Send emails (card vs subscription)
async function sendOrderEmail({ order, user, isSubscription }) {
  if (!user?.email) return;

  const ordersUrl = `${CLIENT_URL}/myorders`;
  if (isSubscription) {
    await sendEmail({
      email: user.email,
      subject: 'Your Konar Profile subscription is active 🎉',
      message: htmlEmail({
        headline: 'Subscription confirmed',
        bodyHtml: `
          <p>Hi ${user.name || 'there'},</p>
          <p>Thanks for subscribing to the <strong>Konar Profile</strong>.</p>
          <p>Your subscription is now active. You can manage it anytime from your dashboard.</p>
        `,
        ctaLabel: 'View my orders',
        ctaUrl: ordersUrl,
      }),
    });
  } else {
    await sendEmail({
      email: user.email,
      subject: 'Order confirmed — thanks for your purchase!',
      message: htmlEmail({
        headline: 'Thanks for your order',
        bodyHtml: `
          <p>Hi ${user.name || 'there'},</p>
          <p>We’ve received your order for the Konar Card.</p>
          ${order.deliveryName || order.deliveryAddress
            ? `<p><strong>Deliver to:</strong><br/>${[order.deliveryName, order.deliveryAddress].filter(Boolean).join('<br/>')}</p>`
            : ''
          }
          <p>We’ll email you tracking details as soon as it ships.</p>
        `,
        ctaLabel: 'View my orders',
        ctaUrl: ordersUrl,
      }),
    });
  }
}

// Upsert Order by stripeSessionId
async function upsertOrderFromSession(session, { isSubscription }) {
  // Pull shipping info
  const ship = shippingFromSession(session);

  // Quantity – get from line items if possible
  let quantity = 1;
  try {
    if (stripe && session.id) {
      const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 10 });
      if (items?.data?.length) {
        // Sum quantities (in case of multiple)
        quantity = items.data.reduce((sum, li) => sum + (li.quantity || 0), 0) || 1;
      }
    }
  } catch (e) {
    console.warn('[stripe] listLineItems failed:', e?.message);
  }

  const type = isSubscription ? 'subscription' : 'card';
  const base = {
    userId: session.metadata?.userId || null, // ensure you passed this when creating the session
    type,
    stripeSessionId: session.id,
    stripeCustomerId: session.customer || null,
    stripeSubscriptionId: isSubscription ? (session.subscription || null) : null,

    quantity,
    amountTotal: typeof session.amount_total === 'number' ? session.amount_total : null,
    currency: session.currency || 'gbp',

    status: isSubscription ? 'active' : 'paid',

    // shipping / delivery fields
    deliveryName: ship.deliveryName || undefined,
    deliveryAddress: ship.deliveryAddress || undefined,
    deliveryWindow: undefined, // left for admin to fill later

    fulfillmentStatus: isSubscription ? undefined : 'order_placed',

    metadata: {
      ...(session.metadata || {}),
      checkoutMode: session.mode,
      paymentStatus: session.payment_status,
    },
  };

  // Find by session id (idempotent)
  let order = await Order.findOne({ stripeSessionId: session.id });
  if (order) {
    // Update existing (e.g., fill in shipping later)
    order.set(base);
    order = await order.save();
  } else {
    order = await Order.create(base);
  }
  return order;
}

// ---------- webhook endpoint ----------
// IMPORTANT: raw parser here. index.js mounts this BEFORE any JSON parser.
router.post(
  '/',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe) {
      console.error('[stripe] Not configured (STRIPE_SECRET_KEY missing)');
      return res.status(500).send('Stripe not configured');
    }

    let event;

    // Verify signature if secret present
    if (webhookSecret) {
      const sig = req.headers['stripe-signature'];
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      } catch (err) {
        console.error('[stripe] Signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }
    } else {
      // Fallback: accept as-is (not recommended for production)
      try {
        event = JSON.parse(req.body.toString());
      } catch (e) {
        return res.status(400).send('Invalid payload');
      }
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;

          const isSubscription = session.mode === 'subscription';
          const isCardPayment = session.mode === 'payment';

          // Upsert order
          const order = await upsertOrderFromSession(session, { isSubscription });

          // Find user by id from order (fallback to stripe customer email if needed)
          let user = null;
          if (order.userId) {
            user = await User.findById(order.userId).select('email name');
          }
          if (!user && session.customer_details?.email) {
            user = await User.findOne({ email: session.customer_details.email.toLowerCase() })
              .select('email name');
          }

          // Send email
          await sendOrderEmail({
            order,
            user,
            isSubscription: !!isSubscription && !isCardPayment,
          });

          break;
        }

        // Optional: fires on successful invoice payments (recurring and sometimes initial)
        case 'invoice.payment_succeeded': {
          const invoice = event.data.object;
          // If you want to send an email on first subscription charge (not free trial)
          if (invoice.billing_reason === 'subscription_create') {
            // Try to find order by subscription id and update it active/paid
            const subId = invoice.subscription;
            if (subId) {
              let order = await Order.findOne({ stripeSubscriptionId: subId });
              if (order) {
                order.status = 'active';
                await order.save();
                const user = await User.findById(order.userId).select('email name');
                await sendOrderEmail({ order, user, isSubscription: true });
              }
            }
          }
          break;
        }

        default:
          // swallow other events
          break;
      }

      res.json({ received: true });
    } catch (err) {
      console.error('[stripe] Handler error:', err);
      res.status(500).send('Webhook handler error');
    }
  }
);

module.exports = router;
