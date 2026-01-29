const mongoose = require('mongoose');
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
        authProvider: {
            type: String,
            default: 'local', // 'local' | 'google' | 'facebook' | 'apple'
        },

        // public profile fields (optional until link claimed)
        profileUrl: { type: String, default: undefined },
        slug: { type: String, default: undefined, trim: true, lowercase: true },
        username: { type: String, default: undefined, trim: true, lowercase: true },

        qrCodeUrl: { type: String, default: '' },

        stripeCustomerId: { type: String, default: undefined },

        isVerified: { type: Boolean, default: false },
        isSubscribed: { type: Boolean, default: false },

        verificationCode: String,
        verificationCodeExpires: Date,

        resetToken: String,
        resetTokenExpires: Date,
    },
    { timestamps: true }
);

/**
 * ✅ Partial unique indexes (the fix)
 * Only enforce uniqueness when the field is actually a string.
 * This prevents "dup key: { profileUrl: null }" forever.
 */
userSchema.index(
    { profileUrl: 1 },
    {
        unique: true,
        partialFilterExpression: { profileUrl: { $type: 'string' } },
    }
);

userSchema.index(
    { slug: 1 },
    {
        unique: true,
        partialFilterExpression: { slug: { $type: 'string' } },
    }
);

userSchema.index(
    { username: 1 },
    {
        unique: true,
        partialFilterExpression: { username: { $type: 'string' } },
    }
);

userSchema.index(
    { googleId: 1 },
    {
        unique: true,
        partialFilterExpression: { googleId: { $type: 'string' } },
    }
);

userSchema.index(
    { stripeCustomerId: 1 },
    {
        unique: true,
        partialFilterExpression: { stripeCustomerId: { $type: 'string' } },
    }
);

module.exports = mongoose.model('User', userSchema);
