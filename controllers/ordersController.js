const Order = require('../models/Order');

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

        metadata: o.metadata || {},
    };
}

module.exports = { listOrders, getOrderById };
