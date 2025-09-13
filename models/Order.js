// models/order.js
const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },

        // "card" for one-time Konar Card purchases, "subscription" for Power Profile
        type: {
            type: String,
            enum: ['card', 'subscription'],
            required: true,
            index: true,
        },

        // Stripe identifiers (optional depending on type)
        stripeSessionId: { type: String, index: true },       // for checkout sessions (card or sub)
        stripeSubscriptionId: { type: String, index: true },  // for recurring sub
        stripeCustomerId: { type: String, index: true },

        // For card orders
        quantity: { type: Number, default: 1 },

        // Money info if you want to store it (in smallest currency unit from Stripe)
        amountTotal: { type: Number }, // e.g., 2495 = £24.95
        currency: { type: String, default: 'gbp' },

        // High-level status you control
        status: {
            type: String,
            enum: ['pending', 'paid', 'active', 'canceled', 'failed'],
            default: 'pending',
            index: true,
        },

        // Optional metadata
        metadata: { type: mongoose.Schema.Types.Mixed },
    },
    { timestamps: true }
);

// Helpful compound index for queries by user + type newest first
OrderSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Order', OrderSchema);
