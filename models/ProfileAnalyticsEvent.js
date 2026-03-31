const mongoose = require("mongoose");

const profileAnalyticsEventSchema = new mongoose.Schema(
    {
        // Who owns the profile (the dashboard user)
        owner_user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },

        // Which profile (business card)
        business_card: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "BusinessCard",
            required: true,
            index: true,
        },

        // Public slug (faster queries, no join needed)
        profile_slug: {
            type: String,
            required: true,
            index: true,
            lowercase: true,
            trim: true,
        },

        // 👇 WHAT happened
        event_type: {
            type: String,
            enum: [
                "profile_view",
                "qr_scan",
                "nfc_tap",
                "link_open",

                "contact_save",           // Save My Number
                "contact_exchange",       // Form submitted
                "contact_exchange_opened",

                "email_clicked",
                "phone_clicked",
                "social_clicked",
            ],
            required: true,
            index: true,
        },

        // 👇 WHERE it came from
        source: {
            type: String,
            enum: [
                "qr",
                "nfc",
                "direct",
                "link",
                "unknown",
            ],
            default: "unknown",
            index: true,
        },

        // 👇 PLATFORM (for socials)
        platform: {
            type: String,
            default: "", // facebook / instagram / etc
            index: true,
        },

        // 👇 Extra metadata (flexible)
        meta: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },

        // Debug / tracking
        ip: { type: String, maxlength: 64 },
        user_agent: { type: String, maxlength: 300 },
    },
    { timestamps: true }
);

// Useful indexes for analytics queries
profileAnalyticsEventSchema.index({ owner_user: 1, createdAt: -1 });
profileAnalyticsEventSchema.index({ profile_slug: 1, createdAt: -1 });
profileAnalyticsEventSchema.index({ event_type: 1, createdAt: -1 });
profileAnalyticsEventSchema.index({ source: 1 });

module.exports = mongoose.model(
    "ProfileAnalyticsEvent",
    profileAnalyticsEventSchema
);