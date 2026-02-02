// Backend/models/user.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

const userSchema = new Schema(
    {
        name: String,

        email: {
            type: String,
            unique: true,
            sparse: true,
            trim: true,
            lowercase: true,
        },

        // local auth
        password: { type: String, default: undefined },

        // social auth
        googleId: { type: String, default: undefined },
        facebookId: { type: String, default: undefined },

        authProvider: {
            type: String,
            default: "local", // 'local' | 'google' | 'facebook' | 'apple'
        },

        // public profile fields (optional until link claimed)
        profileUrl: { type: String, default: undefined },
        slug: { type: String, default: undefined, trim: true, lowercase: true },
        username: { type: String, default: undefined, trim: true, lowercase: true },

        qrCodeUrl: { type: String, default: "" },

        // Stripe IDs
        stripeCustomerId: { type: String, default: undefined },
        stripeSubscriptionId: { type: String, default: undefined },

        /**
         * Subscription / Plan state (source of truth in your app)
         *
         * plan:
         *  - free: default
         *  - plus: paid plan
         *  - teams: paid plan with team features
         *
         * planInterval:
         *  - monthly | quarterly | yearly
         */
        plan: {
            type: String,
            enum: ["free", "plus", "teams"],
            default: "free",
        },
        planInterval: {
            type: String,
            enum: ["monthly", "quarterly", "yearly"],
            default: "monthly", // harmless default; free users won't use it
        },

        /**
         * Stripe subscription status examples:
         * active, trialing, past_due, canceled, unpaid, incomplete, incomplete_expired
         */
        subscriptionStatus: {
            type: String,
            default: "free",
        },

        // When the current paid period ends (useful for gating access / cancel at period end)
        currentPeriodEnd: {
            type: Date,
            default: undefined,
        },

        // ✅ Trial end timestamp (used for free trial gating & banners)
        trialExpires: {
            type: Date,
            default: undefined,
        },

        // Backwards compatibility with your existing checks
        isSubscribed: { type: Boolean, default: false },

        /**
         * ✅ Profile add-on entitlement (IMPORTANT)
         * This is the count of EXTRA profiles the user is paying for.
         *
         * Rules we’ll enforce server-side:
         * - free: base 1 profile included
         * - plus: base 1 profile included (+ extraProfilesQty)
         * - teams: unlimited (ignore extraProfilesQty)
         *
         * Example:
         *  - plus + extraProfilesQty=2 => allowedProfiles = 1 + 2 = 3
         */
        extraProfilesQty: {
            type: Number,
            default: 0,
            min: 0,
        },

        /**
         * Optional Stripe metadata for the add-on (helps reconciliation/debugging)
         * Not required for logic, but useful when syncing from Stripe.
         */
        extraProfilesStripePriceId: {
            type: String,
            default: undefined,
        },
        extraProfilesStripeItemId: {
            type: String,
            default: undefined,
        },

        isVerified: { type: Boolean, default: false },

        verificationCode: String,
        verificationCodeExpires: Date,

        resetToken: String,
        resetTokenExpires: Date,
    },
    { timestamps: true }
);

/**
 * ✅ Partial unique indexes
 * Only enforce uniqueness when the field is actually a string.
 */
userSchema.index(
    { profileUrl: 1 },
    { unique: true, partialFilterExpression: { profileUrl: { $type: "string" } } }
);

userSchema.index(
    { slug: 1 },
    { unique: true, partialFilterExpression: { slug: { $type: "string" } } }
);

userSchema.index(
    { username: 1 },
    { unique: true, partialFilterExpression: { username: { $type: "string" } } }
);

userSchema.index(
    { googleId: 1 },
    { unique: true, partialFilterExpression: { googleId: { $type: "string" } } }
);

userSchema.index(
    { facebookId: 1 },
    { unique: true, partialFilterExpression: { facebookId: { $type: "string" } } }
);

userSchema.index(
    { stripeCustomerId: 1 },
    { unique: true, partialFilterExpression: { stripeCustomerId: { $type: "string" } } }
);

// Helpful if you ever want to quickly find by subscription id
userSchema.index(
    { stripeSubscriptionId: 1 },
    {
        unique: true,
        sparse: true,
        partialFilterExpression: { stripeSubscriptionId: { $type: "string" } },
    }
);

module.exports = mongoose.model("User", userSchema);
