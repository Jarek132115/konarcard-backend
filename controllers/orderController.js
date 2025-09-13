// controllers/ordersController.js
const Order = require('../models/Order');

/**
 * GET /orders
 * Returns the authenticated user's orders (both card purchases and subscriptions),
 * newest first.
 */
const listOrders = async (req, res) => {
    if (!req.user || !req.user.id) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const orders = await Order.find({ userId: req.user.id })
            .sort({ createdAt: -1 })
            .lean();

        // Optional: shape/rename fields for the frontend
        const result = orders.map(o => ({
            id: o._id,
            type: o.type, // 'card' | 'subscription'
            status: o.status, // 'pending' | 'paid' | 'active' | 'canceled' | 'failed'
            quantity: o.quantity || 1,
            amountTotal: o.amountTotal ?? null,
            currency: o.currency || 'gbp',
            stripeSessionId: o.stripeSessionId || null,
            stripeSubscriptionId: o.stripeSubscriptionId || null,
            createdAt: o.createdAt,
            updatedAt: o.updatedAt,
            metadata: o.metadata || {},
        }));

        res.status(200).json({ data: result });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch orders', details: err.message });
    }
};

module.exports = {
    listOrders,
};
