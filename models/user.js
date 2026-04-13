const mongoose = require("mongoose");
const { Schema } = mongoose;

const userSchema = new Schema(
    {
        name: {
            type: String,
            trim: true,
        },

        email: {
            type: String,
            unique: true,
            sparse: true,
            trim: true,
            lowercase: true,
        },

        role: {
            type: String,
            enum: ["user", "admin"],
            default: "user",
            lowercase: true,
            trim: true,
        },

        // local auth
        password: { type: String, default: undefined },

        // social auth
        googleId: { type: String, default: undefined, trim: true },
        facebookId: { type: String, default: undefined, trim: true },

        authProvider: {
            type: String,
            default: "local",
            trim: true,
        },

        // public profile fields (optional until link claimed)
        profileUrl: { type: String, default: undefined, trim: true },
        slug: { type: String, default: undefined, trim: true, lowercase: true },
        username: { type: String, default: undefined, trim: true, lowercase: true },

        qrCodeUrl: { type: String, default: "", trim: true },

        // Stripe IDs
        stripeCustomerId: { type: String, default: undefined, trim: true },
        stripeSubscriptionId: { type: String, default: undefined, trim: true },

        /**
         * Subscription / Plan state (source of truth)
         * free | plus | teams
         */
        plan: {
            type: String,
            enum: ["free", "plus", "teams"],
            default: "free",
            lowercase: true,
            trim: true,
        },

        planInterval: {
            type: String,
            enum: ["monthly", "quarterly", "yearly"],
            default: "monthly",
            lowercase: true,
            trim: true,
        },

        subscriptionStatus: {
            type: String,
            default: "free",
            lowercase: true,
            trim: true,
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
         * extraProfilesQty = number of paid extra profiles.
         */
        extraProfilesQty: {
            type: Number,
            default: 0,
            min: 0,
        },
        extraProfilesStripePriceId: {
            type: String,
            default: undefined,
            trim: true,
        },
        extraProfilesStripeItemId: {
            type: String,
            default: undefined,
            trim: true,
        },

        /**
         * teamsProfilesQty = total allowed profiles on Teams.
         * Example:
         *  - 1 => base Teams only
         *  - 3 => base Teams + 2 extras
         */
        teamsProfilesQty: {
            type: Number,
            default: 1,
            min: 1,
        },
        teamsStripePriceId: {
            type: String,
            default: undefined,
            trim: true,
        },
        teamsStripeItemId: {
            type: String,
            default: undefined,
            trim: true,
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
 * Partial unique indexes
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