// backend/routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const Stripe = require('stripe');

const Order = require('../models/Order');
const User = require('../models/user');
const sendEmail = require('../utils/SendEmail');

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const CLIENT_URL = (process.env.CLIENT_URL || 'https://www.konarcard.com').replace(/\/+$/, '');

// -------------------- Admin Auth --------------------
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

function orderLinkForUser() {
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

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// -------------------- Routes --------------------

/**
 * GET /admin/orders
 * Query:
 *  - q   : partial email | name | username | userId | orderId | stripe ids | tracking url
 *  - type, status, fulfillmentStatus
 *  - limit (<=200)
 */
router.get('/admin/orders', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { type, status, fulfillmentStatus } = req.query;
        const q = (req.query.q || '').trim();
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

        const where = {};
        if (type) where.type = type;
        if (status) where.status = status;
        if (fulfillmentStatus) where.fulfillmentStatus = fulfillmentStatus;

        if (q) {
            const looksObjectId = /^[a-f0-9]{24}$/i.test(q);
            if (looksObjectId) {
                where.$or = [{ _id: q }, { userId: q }];
            } else {
                const rx = new RegExp(escapeRegex(q), 'i');
                const users = await User.find({
                    $or: [{ email: rx }, { name: rx }, { username: rx }],
                }).select('_id').lean();

                const userIds = users.map(u => u._id);
                const orderFieldOr = [{ stripeSessionId: rx }, { stripeSubscriptionId: rx }, { trackingUrl: rx }];

                where.$or = userIds.length ? [{ userId: { $in: userIds } }, ...orderFieldOr] : orderFieldOr;
            }
        }

        // Populate user for name/email/username so UI can show it
        const docs = await Order.find(where)
            .sort({ createdAt: -1 })
            .limit(limit)
            .populate({ path: 'userId', select: 'email name username' })
            .lean();

        // Normalize payload to include `user` consistently
        const data = docs.map(o => ({
            ...o,
            user: o.userId
                ? { id: o.userId._id, email: o.userId.email || null, name: o.userId.name || null, username: o.userId.username || null }
                : null,
            userId: o.userId?._id || o.userId,
        }));

        res.json({ data });
    } catch (err) {
        console.error('Admin list orders error:', err);
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

/**
 * PATCH /admin/orders/:orderId/status
 */
router.patch('/admin/orders/:orderId/status', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { orderId } = req.params;
        const { fulfillmentStatus, notify } = req.body;

        const next = safeFulfillmentStatus(fulfillmentStatus);
        if (!next) return res.status(400).json({ error: 'Invalid fulfillmentStatus' });

        const order = await Order.findByIdAndUpdate(orderId, { $set: { fulfillmentStatus: next } }, { new: true });
        if (!order) return res.status(404).json({ error: 'Order not found' });

        if (notify) {
            const user = await User.findById(order.userId).select('email name');
            if (user?.email) {
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
                        ctaUrl: orderLinkForUser(order),
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
 */
router.patch('/admin/orders/:orderId/tracking', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { orderId } = req.params;
        const { trackingUrl, deliveryWindow, notify } = req.body;

        const updates = {};
        if (typeof trackingUrl === 'string') updates.trackingUrl = trackingUrl.trim();
        if (typeof deliveryWindow === 'string') updates.deliveryWindow = deliveryWindow.trim();

        const order = await Order.findByIdAndUpdate(orderId, { $set: updates }, { new: true });
        if (!order) return res.status(404).json({ error: 'Order not found' });

        if (notify && updates.trackingUrl) {
            const user = await User.findById(order.userId).select('email name');
            if (user?.email) {
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
                        ctaUrl: orderLinkForUser(order),
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
