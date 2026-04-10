const mongoose = require("mongoose");

const nfcOrderSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },

        profile: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "BusinessCard",
            required: true,
            index: true,
        },

        // "plastic-white" | "plastic-black" | "metal-card" | "konartag"
        productKey: {
            type: String,
            required: true,
            index: true,
            trim: true,
        },

        // "white" | "black" | "gold" etc
        variant: {
            type: String,
            default: "",
            index: true,
            trim: true,
        },

        quantity: {
            type: Number,
            required: true,
            min: 1,
            max: 50,
            default: 1,
        },

        // Uploaded logo (S3 url)
        logoUrl: {
            type: String,
            default: "",
            trim: true,
        },

        // Final preview image (product + logo)
        previewImageUrl: {
            type: String,
            default: "",
            trim: true,
        },

        // Flexible preview/customisation JSON
        preview: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },

        currency: {
            type: String,
            default: "gbp",
            trim: true,
            lowercase: true,
        },

        // stored in pennies
        amountTotal: {
            type: Number,
            default: 0,
        },

        // Stripe linkage
        stripeCustomerId: {
            type: String,
            default: "",
            trim: true,
        },

        stripeCheckoutSessionId: {
            type: String,
            default: "",
            trim: true,
        },

        stripePaymentIntentId: {
            type: String,
            default: "",
            trim: true,
        },

        /**
         * Payment / high-level order lifecycle
         */
        status: {
            type: String,
            enum: ["draft", "pending", "paid", "failed", "cancelled", "fulfilled"],
            default: "pending",
            index: true,
        },

        /**
         * Internal fulfilment / shipping progress for admin control
         */
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

        /**
         * Shipping / delivery info
         */
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
    },
    { timestamps: true }
);

module.exports = mongoose.model("NfcOrder", nfcOrderSchema);