const express = require('express');
const router = express.Router();
const Stripe = require('stripe');

const stripeSecret = process.env.STRIPE_SECRET_KEY;
if (!stripeSecret) {
  console.warn('[stripe] STRIPE_SECRET_KEY is not set. Webhook will not work.');
}
const stripe = stripeSecret ? new Stripe(stripeSecret, { apiVersion: '2024-06-20' }) : null;

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const CLIENT_URL = (process.env.CLIENT_URL || 'https://www.konarcard.com').replace(/\/+$/, '');

const Order = require('../models/Order');
const User = require('../models/user');
const sendEmail = require('../utils/SendEmail');

// ---------------- helpers ----------------
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
  const parts = [
    addr.line1,
    addr.line2,
    [addr.city, addr.state].filter(Boolean).join(', '),
    addr.postal_code,
    addr.country,
  ].filter(Boolean);
  return parts.join(', ');
}

function shippingFromSession(session) {
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

function computeDeliveryWindow() {
  const today = new Date();
  const start = new Date(today); start.setDate(today.getDate() + 1);
  const end = new Date(today); end.setDate(today.getDate() + 4);

  const long = (d) => d.toLocaleString('en-GB', { month: 'long' });
  const short = (d) => d.toLocaleString('en-GB', { month: 'short' });

  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
  if (sameMonth) return `${start.getDate()}–${end.getDate()} ${long(start)}`;

  const sameYear = start.getFullYear() === end.getFullYear();
  if (sameYear) return `${start.getDate()} ${short(start)} – ${end.getDate()} ${short(end)}`;

  return `${start.getDate()} ${short(start)} ${start.getFullYear()} – ${end.getDate()} ${short(end)} ${end.getFullYear()}`;
}

async function safeSendOrderEmail({ order, user, isSubscription }) {
  try {
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
  } catch (err) {
    console.error('[email] sendOrderEmail failed:', err?.message || err);
  }
}

/**
 * Upsert Order
 * - Deduplicates by `stripeSessionId` for card purchases
 * - Deduplicates by `stripeSubscriptionId` for subscriptions
 * - Saves subscription trial/billing dates
 */
async function upsertOrderFromSession(session, { isSubscription, fallbackUserId } = {}) {
  const ship = shippingFromSession(session);

  // Quantity
  let quantity = 1;
  try {
    if (stripe && session.id) {
      const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 20 });
      if (items?.data?.length) {
        quantity = items.data.reduce((sum, li) => sum + (li.quantity || 0), 0) || 1;
      }
    }
  } catch (e) {
    console.warn('[stripe] listLineItems failed:', e?.message);
  }

  const base = {
    userId: session.metadata?.userId || fallbackUserId || null,
    type: isSubscription ? 'subscription' : 'card',
    stripeSessionId: session.id,
    stripeCustomerId: session.customer || null,
    stripeSubscriptionId: isSubscription ? (session.subscription || null) : null,

    quantity,
    amountTotal: typeof session.amount_total === 'number' ? session.amount_total : null,
    currency: session.currency || 'gbp',
    status: isSubscription ? 'active' : (session.payment_status === 'paid' ? 'paid' : 'pending'),

    deliveryName: ship.deliveryName || undefined,
    deliveryAddress: ship.deliveryAddress || undefined,
    fulfillmentStatus: isSubscription ? undefined : 'order_placed',

    metadata: {
      ...(session.metadata || {}),
      checkoutMode: session.mode,
      paymentStatus: session.payment_status,
    },
  };

  // For subscriptions, fetch subscription object to get trial and billing info
  if (isSubscription && session.subscription) {
    try {
      const sub = await stripe.subscriptions.retrieve(session.subscription);
      if (sub) {
        base.trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000) : null;
        base.currentPeriodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
      }
    } catch (e) {
      console.warn('[stripe] retrieve subscription failed:', e?.message);
    }
  }

  // Deduplication
  let order = null;
  if (isSubscription && base.stripeSubscriptionId) {
    order = await Order.findOne({ stripeSubscriptionId: base.stripeSubscriptionId });
  } else {
    order = await Order.findOne({ stripeSessionId: session.id });
  }

  if (order) {
    const prevETA = order.deliveryWindow;
    order.set(base);
    if (!isSubscription) {
      order.deliveryWindow = prevETA || computeDeliveryWindow();
    } else if (prevETA) {
      order.deliveryWindow = prevETA;
    }
    order = await order.save();
  } else {
    const doc = { ...base };
    if (!isSubscription) doc.deliveryWindow = computeDeliveryWindow();
    order = await Order.create(doc);
  }
  return order;
}

// ---------------- webhook endpoint ----------------
router.post(
  '/',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe) {
      console.error('[stripe] Not configured (STRIPE_SECRET_KEY missing)');
      return res.status(500).send('Stripe not configured');
    }

    let event;

    if (webhookSecret) {
      const sig = req.headers['stripe-signature'];
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      } catch (err) {
        console.error('[stripe] Signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }
    } else {
      try {
        event = JSON.parse(req.body.toString());
      } catch {
        return res.status(400).send('Invalid payload');
      }
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const isSubscription = session.mode === 'subscription';
          const order = await upsertOrderFromSession(session, { isSubscription });

          // Find user
          let user = null;
          if (order.userId) {
            user = await User.findById(order.userId).select('email name');
          }
          if (!user && session.customer_details?.email) {
            user = await User.findOne({
              email: (session.customer_details.email || '').toLowerCase(),
            }).select('email name');
          }

          const alreadySent = !!(order.metadata && order.metadata.confirmEmailSent);
          if (!alreadySent && session.payment_status === 'paid') {
            await safeSendOrderEmail({ order, user, isSubscription: !!isSubscription });
            await Order.updateOne(
              { _id: order._id },
              { $set: { 'metadata.confirmEmailSent': true } }
            );
          }
          break;
        }

        case 'invoice.payment_succeeded': {
          const invoice = event.data.object;
          if (invoice.billing_reason === 'subscription_create') {
            const subId = invoice.subscription;
            if (subId) {
              let order = await Order.findOne({ stripeSubscriptionId: subId });
              if (order) {
                const alreadySent = !!(order.metadata && order.metadata.confirmEmailSent);
                order.status = 'active';
                await order.save();

                if (!alreadySent) {
                  const user = await User.findById(order.userId).select('email name');
                  await safeSendOrderEmail({ order, user, isSubscription: true });
                  await Order.updateOne(
                    { _id: order._id },
                    { $set: { 'metadata.confirmEmailSent': true } }
                  );
                }
              }
            }
          }
          break;
        }

        default:
          break;
      }

      res.json({ received: true });
    } catch (err) {
      console.error('[stripe] Handler error:', err);
      res.status(500).send('Webhook handler error');
    }
  }
);

// ---------------- confirm endpoint ----------------
router.get('/confirm', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
    const sessionId = req.query.session_id;
    if (!sessionId) return res.status(400).json({ error: 'Missing session_id' });

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const isSubscription = session.mode === 'subscription';

    let fallbackUserId = null;
    if (session.customer_details?.email) {
      const u = await User.findOne({ email: (session.customer_details.email || '').toLowerCase() }).select('_id');
      if (u) fallbackUserId = u._id;
    }

    let order = await upsertOrderFromSession(session, { isSubscription, fallbackUserId });

    const isPaid = session.payment_status === 'paid';
    const alreadySent = !!(order.metadata && order.metadata.confirmEmailSent);
    if (isPaid && !alreadySent) {
      let user = null;
      if (order.userId) user = await User.findById(order.userId).select('email name');
      if (!user && session.customer_details?.email) {
        user = await User.findOne({ email: (session.customer_details.email || '').toLowerCase() }).select('email name');
      }
      await safeSendOrderEmail({ order, user, isSubscription });
      await Order.updateOne(
        { _id: order._id },
        { $set: { 'metadata.confirmEmailSent': true } }
      );
      order = await Order.findById(order._id).lean();
    }

    return res.json({ success: true, data: order });
  } catch (err) {
    console.error('[stripe] confirm error:', err);
    return res.status(500).json({ error: 'Failed to confirm session' });
  }
});

module.exports = router;
