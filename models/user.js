const mongoose = require('mongoose');
const { Schema } = mongoose;

const userSchema = new Schema({
    name: String,
    email: {
        type: String,
        unique: true,
    },
    password: String,
    profileUrl: {
        type: String,
        unique: true,
    },
    slug: {
        type: String,
        unique: true,
        sparse: true,
    },
    qrCode: String,
    stripeCustomerId: {
        type: String,
        unique: true,
        sparse: true,
    },
    stripeSubscriptionId: {
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
    username: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true,
    },
    verificationCode: String,
    verificationCodeExpires: Date,
    resetPasswordToken: String,
    resetPasswordExpires: Date,
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);