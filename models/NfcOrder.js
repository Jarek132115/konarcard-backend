// backend/models/NfcOrder.js
const mongoose = require("mongoose");

const nfcOrderSchema = new mongoose.Schema(
    {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
        profile: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessCard", required: true, index: true },

        // "plastic-card" | "metal-card" | "konartag"
        productKey: { type: String, required: true, index: true },

        // "white" | "black" | "gold" (depends on product)
        variant: { type: String, default: "", index: true },

        quantity: { type: Number, required: true, min: 1, max: 50, default: 1 },

        // Uploaded logo (S3 url)
        logoUrl: { type: String, default: "" },

        // ✅ IMPORTANT: store the final preview image (product + logo) for “My Cards”
        previewImageUrl: { type: String, default: "" },

        // Whatever they configured on the preview (keep flexible JSON)
        preview: { type: mongoose.Schema.Types.Mixed, default: {} },

        currency: { type: String, default: "gbp" },
        amountTotal: { type: Number, default: 0 }, // in pennies

        // Stripe linkage
        stripeCustomerId: { type: String, default: "" },
        stripeCheckoutSessionId: { type: String, default: "" },
        stripePaymentIntentId: { type: String, default: "" },

        status: {
            type: String,
            enum: ["draft", "pending", "paid", "failed", "cancelled", "fulfilled"],
            default: "pending",
            index: true,
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model("NfcOrder", nfcOrderSchema);
