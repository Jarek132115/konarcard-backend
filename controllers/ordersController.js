// backend/controllers/ordersController.js
const Order = require('../models/Order');
const User = require('../models/user');
const Stripe = require('stripe');

const stripeSecret = process.env.STRIPE_SECRET_KEY;
const stripe = stripeSecret ? new Stripe(stripeSecret, { apiVersion: '2024-06-20' }) : null;

/**
 * GET /me/orders
 * Returns all of the authenticated user's orders.
 */
const listOrders = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const orders = await Order.find({ userId })
            .sort({ createdAt: -1 })
            .lean();

        // Filter out unpaid/pending card orders
        const filtered = orders.filter(
            (o) => !(o.type === 'card' && o.status === 'pending')
        );

        const result = filtered.map(formatOrderForResponse);
        res.status(200).json({ data: result });
    } catch (err) {
        console.error('Error fetching orders:', err);
        res.status(500).json({ error: 'Failed to fetch orders', details: err.message });
    }
};

/**
 * GET /me/orders/:id
 * Returns a single order by ID (if it belongs to the authenticated user).
 */
const getOrderById = async (req, res) => {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const order = await Order.findOne({ _id: id, userId }).lean();
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }

        // Skip unpaid card orders
        if (order.type === 'card' && order.status === 'pending') {
            return res.status(404).json({ error: 'Order not found' });
        }

        res.status(200).json({ data: formatOrderForResponse(order) });
    } catch (err) {
        console.error('Error fetching order:', err);
        res.status(500).json({ error: 'Failed to fetch order', details: err.message });
    }
};

/**
 * POST /me/sync-subscriptions
 * Pull latest subscription state from Stripe and update Orders + User.
 */
const syncSubscriptions = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!stripe) {
        // Not configured — no-op so frontend doesn’t break
        return res.status(200).json({ success: true, message: 'Stripe not configured; skipped.' });
    }

    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        // All subscription orders for this user
        const subs = await Order.find({ userId, type: 'subscription' });
        for (const o of subs) {
            if (!o.stripeSubscriptionId) continue;

            try {
                const sub = await stripe.subscriptions.retrieve(o.stripeSubscriptionId);

                // Update order fields
                const status = (sub.status || '').toLowerCase();
                o.status = status === 'canceled' ? 'canceled' : status;
                o.trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000) : o.trialEnd || null;
                o.currentPeriodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : o.currentPeriodEnd || null;

                // mirror cancel_at_period_end
                o.metadata = { ...(o.metadata || {}), cancel_at_period_end: !!sub.cancel_at_period_end };
                await o.save();

                // Update user flags if this matches their current subscription
                if (String(o.userId) === String(user._id)) {
                    const isActive = ['active', 'trialing', 'past_due', 'unpaid'].includes(status);
                    user.isSubscribed = isActive;
                    if (sub.customer && !user.stripeCustomerId) user.stripeCustomerId = sub.customer;
                    // track the latest sub id we see
                    user.stripeSubscriptionId = sub.id;
                    await user.save();
                }
            } catch (e) {
                // If subscription missing in Stripe, mark canceled locally
                if (e?.raw?.code === 'resource_missing') {
                    o.status = 'canceled';
                    o.metadata = { ...(o.metadata || {}), cancel_at_period_end: false };
                    await o.save();

                    if (String(o.userId) === String(user._id)) {
                        user.isSubscribed = false;
                        if (user.stripeSubscriptionId === o.stripeSubscriptionId) {
                            user.stripeSubscriptionId = undefined;
                        }
                        await user.save();
                    }
                } else {
                    console.warn('[sync-subscriptions] retrieve failed:', e?.message);
                }
            }
        }

        return res.status(200).json({ success: true });
    } catch (err) {
        console.error('syncSubscriptions error:', err);
        res.status(500).json({ error: 'Failed to sync subscriptions', details: err.message });
    }
};

// helper to keep consistent response shape
function formatOrderForResponse(o) {
    return {
        id: o._id,
        type: o.type,
        status: o.status,
        quantity: o.type === 'card' ? (o.quantity || 1) : null,
        amountTotal: o.amountTotal ?? null,
        currency: o.currency || 'gbp',
        stripeSessionId: o.stripeSessionId || null,
        stripeSubscriptionId: o.stripeSubscriptionId || null,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,

        fulfillmentStatus: o.fulfillmentStatus || 'order_placed',
        trackingUrl: o.trackingUrl || null,
        deliveryName: o.deliveryName || o?.metadata?.deliveryName || null,
        deliveryAddress: o.deliveryAddress || o?.metadata?.deliveryAddress || null,

        deliveryWindow: o.deliveryWindow || null,

        trialEnd: o.trialEnd || null,
        currentPeriodEnd: o.currentPeriodEnd || null,

        // 👇 expose cancel-at-period-end at top-level for the frontend
        cancel_at_period_end:
            o?.metadata?.cancel_at_period_end === true || o?.metadata?.cancel_at_period_end === 'true',

        metadata: o.metadata || {},
    };
}

module.exports = { listOrders, getOrderById, syncSubscriptions };
