// backend/routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const Stripe = require('stripe');

const Order = require('../models/Order');
const User = require('../models/user');
const sendEmail = require('../utils/SendEmail');

const stripe = process.env.STRIPE_SECRET_KEY ? new (require('stripe'))(process.env.STRIPE_SECRET_KEY) : null;

const CLIENT_URL = (process.env.CLIENT_URL || 'https://www.konarcard.com').replace(/\/+$/, '');

// -------------------- Admin Auth --------------------
// You already decode JWT into req.user in index.js.
// We check against allow-lists in env:
//   ADMIN_EMAILS = "owner@site.com,other@site.com"
//   ADMIN_USER_IDS = "64a...,64b..."
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

function requireAuth(req, res, next) {
    if (req.user?.id) return next();
    return res.status(401).json({ error: 'Unauthorized' });
}

function requireAdmin(req, res, next) {
    const email = (req.user?.email || '').toLowerCase();
    const id = req.user?.id;
    const isAdmin =
        (email && ADMIN_EMAILS.includes(email)) ||
        (id && ADMIN_USER_IDS.includes(String(id)));
    if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
    next();
}

// -------------------- Helpers --------------------
function safeFulfillmentStatus(s) {
    const allowed = ['order_placed', 'designing_card', 'packaged', 'shipped'];
    return allowed.includes(s) ? s : null;
}

function statusBadgeText(s) {
    switch (s) {
        case 'order_placed': return 'Order placed';
        case 'designing_card': return 'Designing your card';
        case 'packaged': return 'Packaged';
        case 'shipped': return 'Shipped';
        default: return 'Order update';
    }
}

function orderLinkForUser(order) {
    // For simplicity, always send them to My Orders (covers both card/sub)
    return `${CLIENT_URL}/myorders`;
}

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

// -------------------- Routes --------------------

/**
 * GET /admin/orders
 * Optional query:
 *  - type=card|subscription
 *  - status=pending|paid|active|canceled|failed
 *  - fulfillmentStatus=order_placed|designing_card|packaged|shipped
 *  - q=<email or userId>
 *  - limit (default 50)
 */
router.get('/admin/orders', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { type, status, fulfillmentStatus, q } = req.query;
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

        const where = {};
        if (type) where.type = type;
        if (status) where.status = status;
        if (fulfillmentStatus) where.fulfillmentStatus = fulfillmentStatus;

        // Basic search: by user email or userId
        if (q) {
            const user = await User.findOne({
                $or: [
                    { email: new RegExp(`^${q}$`, 'i') },
                    { _id: q.match(/^[a-f0-9]{24}$/i) ? q : null },
                ].filter(Boolean),
            }).select('_id');
            if (user) where.userId = user._id;
            else where._id = null; // return empty if no match
        }

        const orders = await Order.find(where).sort({ createdAt: -1 }).limit(limit).lean();

        res.json({ data: orders });
    } catch (err) {
        console.error('Admin list orders error:', err);
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

/**
 * PATCH /admin/orders/:orderId/status
 * Body: { fulfillmentStatus: 'order_placed'|'designing_card'|'packaged'|'shipped', notify?: boolean }
 * Sends a generic "order updated" email if notify=true.
 */
router.patch('/admin/orders/:orderId/status', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { orderId } = req.params;
        const { fulfillmentStatus, notify } = req.body;

        const next = safeFulfillmentStatus(fulfillmentStatus);
        if (!next) return res.status(400).json({ error: 'Invalid fulfillmentStatus' });

        const order = await Order.findByIdAndUpdate(
            orderId,
            { $set: { fulfillmentStatus: next } },
            { new: true }
        );
        if (!order) return res.status(404).json({ error: 'Order not found' });

        // Optionally notify
        if (notify) {
            const user = await User.findById(order.userId).select('email name');
            if (user?.email) {
                const link = orderLinkForUser(order);
                await sendEmail({
                    email: user.email,
                    subject: `Your KonarCard order was updated: ${statusBadgeText(order.fulfillmentStatus)}`,
                    message: htmlEmail({
                        headline: 'Order update',
                        bodyHtml: `
              <p>Hi ${user.name || 'there'},</p>
              <p>Your order status is now: <strong>${statusBadgeText(order.fulfillmentStatus)}</strong>.</p>
              <p>For the latest information about your delivery, visit your order page.</p>
            `,
                        ctaLabel: 'View your order',
                        ctaUrl: link,
                    }),
                });
            }
        }

        res.json({ success: true, data: order });
    } catch (err) {
        console.error('Admin update status error:', err);
        res.status(500).json({ error: 'Failed to update order status' });
    }
});

/**
 * PATCH /admin/orders/:orderId/tracking
 * Body: { trackingUrl?: string, deliveryWindow?: string, notify?: boolean }
 * If trackingUrl is provided and notify=true, sends "your order has been shipped" email with the tracking link.
 */
router.patch('/admin/orders/:orderId/tracking', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { orderId } = req.params;
        let { trackingUrl, deliveryWindow, notify } = req.body;

        const updates = {};
        if (typeof trackingUrl === 'string') updates.trackingUrl = trackingUrl.trim();
        if (typeof deliveryWindow === 'string') updates.deliveryWindow = deliveryWindow.trim();

        const order = await Order.findByIdAndUpdate(orderId, { $set: updates }, { new: true });
        if (!order) return res.status(404).json({ error: 'Order not found' });

        // If tracking provided and notify, send shipped email
        if (notify && updates.trackingUrl) {
            const user = await User.findById(order.userId).select('email name');
            if (user?.email) {
                const ordersLink = orderLinkForUser(order);
                await sendEmail({
                    email: user.email,
                    subject: 'Your KonarCard order has shipped 🚚',
                    message: htmlEmail({
                        headline: 'Your order is on its way',
                        bodyHtml: `
              <p>Hi ${user.name || 'there'},</p>
              <p>Your Konar Card has been shipped.</p>
              ${order.deliveryWindow ? `<p>Estimated delivery: <strong>${order.deliveryWindow}</strong></p>` : ''}
              <p>You can track your parcel here:</p>
              <p><a href="${updates.trackingUrl}" target="_blank" rel="noopener" style="color:#0a66c2; word-break:break-all;">${updates.trackingUrl}</a></p>
              <p>For the latest order information, visit your orders page.</p>
            `,
                        ctaLabel: 'View my orders',
                        ctaUrl: ordersLink,
                    }),
                });
            }
        }

        res.json({ success: true, data: order });
    } catch (err) {
        console.error('Admin update tracking error:', err);
        res.status(500).json({ error: 'Failed to update tracking' });
    }
});

/**
 * POST /admin/subscription/:orderId/cancel
 * Cancels a subscription at period end in Stripe.
 */
router.post('/admin/subscription/:orderId/cancel', requireAuth, requireAdmin, async (req, res) => {
    try {
        if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

        const { orderId } = req.params;
        const order = await Order.findById(orderId).lean();
        if (!order) return res.status(404).json({ error: 'Order not found' });
        if (order.type !== 'subscription' || !order.stripeSubscriptionId) {
            return res.status(400).json({ error: 'Not a subscription order' });
        }

        const updated = await stripe.subscriptions.update(order.stripeSubscriptionId, {
            cancel_at_period_end: true,
        });

        res.json({ success: true, data: { id: updated.id, status: updated.status, cancel_at_period_end: updated.cancel_at_period_end } });
    } catch (err) {
        console.error('Admin cancel subscription error:', err);
        res.status(500).json({ error: 'Failed to cancel subscription' });
    }
});

module.exports = router;
