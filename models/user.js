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
            default: "local",
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
         * Subscription / Plan state (source of truth)
         * free | plus | teams
         */
        plan: {
            type: String,
            enum: ["free", "plus", "teams"],
            default: "free",
        },

        planInterval: {
            type: String,
            enum: ["monthly", "quarterly", "yearly"],
            default: "monthly",
        },

        subscriptionStatus: {
            type: String,
            default: "free",
        },

        currentPeriodEnd: {
            type: Date,
            default: undefined,
        },

        trialExpires: {
            type: Date,
            default: undefined,
        },

        // Backwards compatibility
        isSubscribed: { type: Boolean, default: false },

        /**
         * ✅ PLUS ADD-ON ENTITLEMENT
         * extraProfilesQty = number of EXTRA profiles paid for on Plus.
         * (Allowed = 1 + extraProfilesQty)
         */
        extraProfilesQty: {
            type: Number,
            default: 0,
            min: 0,
        },
        extraProfilesStripePriceId: {
            type: String,
            default: undefined,
        },
        extraProfilesStripeItemId: {
            type: String,
            default: undefined,
        },

        /**
         * ✅ TEAMS ENTITLEMENT (THIS IS WHAT YOU NEED NOW)
         * We store the Stripe subscription item quantity here.
         * This is the number of profiles/seats they paid for.
         *
         * Example:
         *  - teamsProfilesQty = 3  => allow 3 profiles
         */
        teamsProfilesQty: {
            type: Number,
            default: 1,
            min: 1,
        },
        teamsStripePriceId: {
            type: String,
            default: undefined,
        },
        teamsStripeItemId: {
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

userSchema.index(
    { stripeSubscriptionId: 1 },
    {
        unique: true,
        sparse: true,
        partialFilterExpression: { stripeSubscriptionId: { $type: "string" } },
    }
);

module.exports = mongoose.model("User", userSchema);
