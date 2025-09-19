// backend/models/Order.js
const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            index: true,
        },

        type: {
            type: String,
            enum: ['card', 'subscription'],
            required: true,
            index: true,
        },

        stripeSessionId: { type: String, index: true },
        stripeSubscriptionId: { type: String, index: true },
        stripeCustomerId: { type: String, index: true },

        quantity: { type: Number, default: 1 },

        amountTotal: { type: Number },
        currency: { type: String, default: 'gbp' },

        status: {
            type: String,
            enum: ['pending', 'paid', 'active', 'canceled', 'failed'],
            default: 'pending',
            index: true,
        },

        // --- New admin-managed shipping/fulfilment fields ---
        fulfillmentStatus: {
            type: String,
            enum: ['order_placed', 'designing_card', 'packaged', 'shipped'],
            default: 'order_placed',
            index: true,
        },
        trackingUrl: { type: String },

        // Displayed to the customer (also mirrored from metadata if present)
        deliveryName: { type: String },
        deliveryAddress: { type: String },

        // Your pre-existing ETA field
        deliveryWindow: { type: String },

        metadata: { type: mongoose.Schema.Types.Mixed },
    },
    { timestamps: true }
);

OrderSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Order', OrderSchema);
