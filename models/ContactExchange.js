// backend/models/ContactExchange.js
const mongoose = require("mongoose");

const contactExchangeSchema = new mongoose.Schema(
    {
        // Which public profile this was submitted on
        profile_slug: { type: String, required: true, index: true, trim: true, lowercase: true },

        // Owner of that profile (user)
        owner_user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

        // The specific BusinessCard profile doc
        business_card: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessCard" },

        // Visitor-submitted fields
        visitor_name: { type: String, required: true, trim: true, maxlength: 80 },
        visitor_email: { type: String, trim: true, lowercase: true, maxlength: 254 },
        visitor_phone: { type: String, trim: true, maxlength: 20 },
        message: { type: String, trim: true, maxlength: 500 },

        // Basic metadata for abuse/debug
        ip: { type: String, maxlength: 64 },
        user_agent: { type: String, maxlength: 300 },
    },
    { timestamps: true }
);

// Helpful compound indexes for “my incoming contacts” queries
contactExchangeSchema.index({ owner_user: 1, createdAt: -1 });
contactExchangeSchema.index({ profile_slug: 1, createdAt: -1 });

module.exports = mongoose.model("ContactExchange", contactExchangeSchema);
