const Order = require('../models/Order');

/**
 * GET /me/orders
 * Returns the authenticated user's orders (both card purchases and subscriptions),
 * newest first.
 */
const listOrders = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const orders = await Order.find({ userId }).sort({ createdAt: -1 }).lean();

        if (!orders || orders.length === 0) {
            return res.status(200).json({ data: [] });
        }

        const result = orders.map((o) => ({
            id: o._id,
            type: o.type, // 'card' | 'subscription'
            status: o.status, // 'pending' | 'paid' | 'active' | 'canceled' | 'failed'
            quantity: o.type === 'card' ? (o.quantity || 1) : null,
            amountTotal: o.amountTotal ?? null,
            currency: o.currency || 'gbp',
            stripeSessionId: o.stripeSessionId || null,
            stripeSubscriptionId: o.stripeSubscriptionId || null,
            createdAt: o.createdAt,
            updatedAt: o.updatedAt,

            // shipping/admin fields
            fulfillmentStatus: o.fulfillmentStatus || 'order_placed',
            trackingUrl: o.trackingUrl || null,
            deliveryName: o.deliveryName || o?.metadata?.deliveryName || null,
            deliveryAddress: o.deliveryAddress || o?.metadata?.deliveryAddress || null,

            // ETA (for card orders)
            deliveryWindow: o.deliveryWindow || null,

            // subscription-specific fields
            trialEnd: o.trialEnd || null,
            currentPeriodEnd: o.currentPeriodEnd || null,

            // raw metadata
            metadata: o.metadata || {},
        }));

        res.status(200).json({ data: result });
    } catch (err) {
        console.error('Error fetching orders:', err);
        res
            .status(500)
            .json({ error: 'Failed to fetch orders', details: err.message });
    }
};

module.exports = { listOrders };
