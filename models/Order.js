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

        // --- Shipping / fulfillment fields (for card orders) ---
        fulfillmentStatus: {
            type: String,
            enum: ['order_placed', 'designing_card', 'packaged', 'shipped'],
            default: 'order_placed',
            index: true,
        },
        trackingUrl: { type: String },

        // Displayed to the customer
        deliveryName: { type: String },
        deliveryAddress: { type: String },

        // ETA (for card orders)
        deliveryWindow: { type: String },

        // --- Subscription-specific fields ---
        trialEnd: { type: Date },            // When free trial ends (if any)
        currentPeriodEnd: { type: Date },    // When current billing cycle ends

        // Arbitrary Stripe metadata
        metadata: { type: mongoose.Schema.Types.Mixed },
    },
    { timestamps: true }
);

// Optimize common queries
OrderSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Order', OrderSchema);
