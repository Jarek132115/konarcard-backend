const mongoose = require("mongoose");

const { Schema } = mongoose;

const nfcOrderSchema = new Schema(
    {
        user: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },

        profile: {
            type: Schema.Types.ObjectId,
            ref: "BusinessCard",
            required: true,
            index: true,
        },

        // Product
        productKey: {
            type: String,
            required: true,
            trim: true,
            index: true,
        },

        variant: {
            type: String,
            default: "",
            trim: true,
            index: true,
        },

        quantity: {
            type: Number,
            required: true,
            min: 1,
            max: 50,
            default: 1,
        },

        // Assets / preview
        logoUrl: {
            type: String,
            default: "",
            trim: true,
        },

        previewImageUrl: {
            type: String,
            default: "",
            trim: true,
        },

        /**
         * QR IMAGE FILE URL
         * This is the uploaded QR PNG image itself, not the destination link.
         */
        qrCodeUrl: {
            type: String,
            default: "",
            trim: true,
        },

        /**
         * Canonical destination links
         * publicProfileUrl = plain profile URL
         * qrTargetUrl = tracked QR destination
         * nfcTargetUrl = tracked NFC destination
         */
        publicProfileUrl: {
            type: String,
            default: "",
            trim: true,
        },

        qrTargetUrl: {
            type: String,
            default: "",
            trim: true,
        },

        nfcTargetUrl: {
            type: String,
            default: "",
            trim: true,
        },

        // Flexible order preview payload
        preview: {
            type: Schema.Types.Mixed,
            default: {},
        },

        // Stripe / money
        currency: {
            type: String,
            default: "gbp",
            trim: true,
            lowercase: true,
        },

        amountTotal: {
            type: Number,
            default: 0, // pennies
        },

        stripeCustomerId: {
            type: String,
            default: "",
            trim: true,
            index: true,
        },

        stripeCheckoutSessionId: {
            type: String,
            default: "",
            trim: true,
            index: true,
        },

        stripePaymentIntentId: {
            type: String,
            default: "",
            trim: true,
            index: true,
        },

        // Payment state
        status: {
            type: String,
            enum: ["draft", "pending", "paid", "failed", "cancelled", "fulfilled"],
            default: "pending",
            index: true,
        },

        // Physical fulfilment state
        fulfillmentStatus: {
            type: String,
            enum: [
                "order_placed",
                "designing_card",
                "packaged",
                "shipped",
                "delivered",
            ],
            default: "order_placed",
            index: true,
        },

        // Shipping / tracking
        trackingUrl: {
            type: String,
            default: "",
            trim: true,
        },

        trackingCode: {
            type: String,
            default: "",
            trim: true,
        },

        deliveryWindow: {
            type: String,
            default: "",
            trim: true,
        },

        // Customer snapshot at time of checkout
        customerName: {
            type: String,
            default: "",
            trim: true,
        },

        customerEmail: {
            type: String,
            default: "",
            trim: true,
            lowercase: true,
        },

        deliveryName: {
            type: String,
            default: "",
            trim: true,
        },

        deliveryAddress: {
            type: String,
            default: "",
            trim: true,
        },

        // Optional raw structured shipping payload
        shipping: {
            type: Schema.Types.Mixed,
            default: {},
        },
    },
    {
        timestamps: true,
    }
);

nfcOrderSchema.index({ user: 1, createdAt: -1 });
nfcOrderSchema.index({ profile: 1, createdAt: -1 });
nfcOrderSchema.index({ productKey: 1, variant: 1 });
nfcOrderSchema.index({ status: 1, fulfillmentStatus: 1, createdAt: -1 });
nfcOrderSchema.index({ publicProfileUrl: 1 });
nfcOrderSchema.index({ qrTargetUrl: 1 });
nfcOrderSchema.index({ nfcTargetUrl: 1 });

module.exports =
    mongoose.models.NfcOrder || mongoose.model("NfcOrder", nfcOrderSchema);