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
        password: String,

        // canonical public profile fields
        profileUrl: {
            type: String,
            unique: true,
            sparse: true,
        },
        slug: {
            type: String,
            unique: true,
            sparse: true,
            trim: true,
            lowercase: true,
        },

        // ✅ store S3 URL here (your controller uses qrCodeUrl)
        qrCodeUrl: {
            type: String,
            default: '',
        },

        stripeCustomerId: {
            type: String,
            unique: true,
            sparse: true,
        },

        isVerified: {
            type: Boolean,
            default: false,
        },
        isSubscribed: {
            type: Boolean,
            default: false,
        },

        // ✅ IMPORTANT: must NOT be required for social signup flow (claim after)
        username: {
            type: String,
            unique: true,
            sparse: true,
            trim: true,
            lowercase: true,
        },

        // email verification
        verificationCode: String,
        verificationCodeExpires: Date,

        // password reset (your controller uses resetToken + resetTokenExpires)
        resetToken: String,
        resetTokenExpires: Date,

        // (optional, for later social auth)
        authProvider: { type: String, default: 'local' },
        providerId: { type: String, default: '' },
    },
    { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
