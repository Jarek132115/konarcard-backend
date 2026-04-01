const mongoose = require("mongoose");

const profileAnalyticsEventSchema = new mongoose.Schema(
    {
        // Owner of the profile being viewed / interacted with
        owner_user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },

        // Specific BusinessCard profile doc
        business_card: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "BusinessCard",
            required: true,
            index: true,
        },

        // Profile slug for easy querying
        profile_slug: {
            type: String,
            required: true,
            trim: true,
            lowercase: true,
            index: true,
        },

        // Main analytics event type
        event_type: {
            type: String,
            enum: [
                "profile_view",
                "qr_scan",
                "nfc_tap",
                "link_open",
                "contact_save",
                "contact_exchange",
                "contact_exchange_opened",
                "email_clicked",
                "phone_clicked",
                "social_clicked",
            ],
            required: true,
            trim: true,
            lowercase: true,
            index: true,
        },

        // High-level source bucket
        // qr | nfc | direct | link | unknown
        source_type: {
            type: String,
            enum: ["qr", "nfc", "direct", "link", "unknown"],
            default: "unknown",
            trim: true,
            lowercase: true,
            index: true,
        },

        // More specific platform/source
        // facebook | instagram | linkedin | google | tiktok | x | other | unknown
        source_platform: {
            type: String,
            default: "unknown",
            trim: true,
            lowercase: true,
            index: true,
        },

        // Where user came from
        referrer: {
            type: String,
            default: "",
            trim: true,
            maxlength: 1000,
        },

        // UTM tracking
        utm_source: {
            type: String,
            default: "",
            trim: true,
            lowercase: true,
            maxlength: 120,
        },
        utm_medium: {
            type: String,
            default: "",
            trim: true,
            lowercase: true,
            maxlength: 120,
        },
        utm_campaign: {
            type: String,
            default: "",
            trim: true,
            lowercase: true,
            maxlength: 160,
        },
        utm_term: {
            type: String,
            default: "",
            trim: true,
            maxlength: 160,
        },
        utm_content: {
            type: String,
            default: "",
            trim: true,
            maxlength: 160,
        },

        // Anonymous tracking ids from frontend
        visitor_id: {
            type: String,
            default: "",
            trim: true,
            maxlength: 120,
            index: true,
        },

        // Browser tab/session id
        session_id: {
            type: String,
            default: "",
            trim: true,
            maxlength: 120,
            index: true,
        },

        // One actual visit/open id
        // refresh should reuse this, new tap/scan/open should create a new one
        visit_id: {
            type: String,
            default: "",
            trim: true,
            maxlength: 120,
            index: true,
        },

        // Optional click target info
        // e.g. phone, email, instagram
        action_target: {
            type: String,
            default: "",
            trim: true,
            lowercase: true,
            maxlength: 120,
        },

        // Optional URL clicked
        target_url: {
            type: String,
            default: "",
            trim: true,
            maxlength: 1200,
        },

        // Device / browser metadata
        user_agent: {
            type: String,
            default: "",
            maxlength: 500,
        },

        ip: {
            type: String,
            default: "",
            maxlength: 64,
        },
    },
    { timestamps: true }
);

// Helpful indexes for analytics queries
profileAnalyticsEventSchema.index({ owner_user: 1, createdAt: -1 });
profileAnalyticsEventSchema.index({ business_card: 1, createdAt: -1 });
profileAnalyticsEventSchema.index({ profile_slug: 1, createdAt: -1 });

profileAnalyticsEventSchema.index({
    owner_user: 1,
    event_type: 1,
    createdAt: -1,
});

profileAnalyticsEventSchema.index({
    business_card: 1,
    event_type: 1,
    createdAt: -1,
});

profileAnalyticsEventSchema.index({
    owner_user: 1,
    source_type: 1,
    createdAt: -1,
});

profileAnalyticsEventSchema.index({
    owner_user: 1,
    source_platform: 1,
    createdAt: -1,
});

profileAnalyticsEventSchema.index({
    business_card: 1,
    event_type: 1,
    source_type: 1,
    visit_id: 1,
    createdAt: -1,
});

profileAnalyticsEventSchema.index({
    business_card: 1,
    event_type: 1,
    source_type: 1,
    session_id: 1,
    createdAt: -1,
});

profileAnalyticsEventSchema.index({
    business_card: 1,
    event_type: 1,
    source_type: 1,
    visitor_id: 1,
    createdAt: -1,
});

module.exports = mongoose.model("ProfileAnalyticsEvent", profileAnalyticsEventSchema);