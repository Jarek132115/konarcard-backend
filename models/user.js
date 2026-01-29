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
        password: String,

        // ✅ social auth
        googleId: {
            type: String,
            unique: true,
            sparse: true,
        },
        authProvider: {
            type: String,
            default: 'local', // 'local' | 'google' | 'facebook' | 'apple'
        },

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

        qrCodeUrl: { type: String, default: '' },

        stripeCustomerId: {
            type: String,
            unique: true,
            sparse: true,
        },

        isVerified: { type: Boolean, default: false },
        isSubscribed: { type: Boolean, default: false },

        // IMPORTANT: optional for social signup flow (claim later)
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

        // password reset
        resetToken: String,
        resetTokenExpires: Date,
    },
    { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
