// controllers/authController.js
const { hashPassword, comparePassword } = require('../helpers/auth');
const User = require('../models/user');
const Order = require('../models/Order'); // <-- NEW: log orders
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const sendEmail = require('../utils/SendEmail');
const { verificationEmailTemplate, passwordResetTemplate } = require('../utils/emailTemplates');
const crypto = require('crypto');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const uploadToS3 = require('../utils/uploadToS3');

const normalizeEmail = (e) => (e || '').trim().toLowerCase();

// TEST
const test = (req, res) => {
    res.json('test is working');
};

// REGISTER
const registerUser = async (req, res) => {
    try {
        const { name, email, username, password, confirmPassword } = req.body;

        if (!name || !email || !username || !password || !confirmPassword) {
            return res.status(400).json({ error: 'All fields are required.' });
        }
        if (password !== confirmPassword) {
            return res.status(400).json({ error: 'Passwords do not match.' });
        }

        const normalizedEmail = normalizeEmail(email);
        const normalizedUsername = (username || '').trim().toLowerCase();

        const existingEmail = await User.findOne({ email: normalizedEmail });
        if (existingEmail) return res.json({ error: 'This email is already registered. Please log in.' });

        const existingUsername = await User.findOne({ username: normalizedUsername });
        if (existingUsername) return res.status(400).json({ error: 'Username already taken. Please choose another.' });

        const hashedPassword = await hashPassword(password);

        const slug = normalizedUsername;
        const profileUrl = `${process.env.CLIENT_URL}/u/${slug}`;
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = Date.now() + 10 * 60 * 1000;

        const user = await User.create({
            name,
            email: normalizedEmail,
            username: normalizedUsername,
            password: hashedPassword,
            profileUrl,
            isVerified: false,
            verificationCode: code,
            verificationCodeExpires: expires,
            slug,
        });

        const qrBuffer = await QRCode.toBuffer(profileUrl, {
            width: 500,
            color: { dark: '#000000', light: '#ffffff' },
        });

        const fileKey = `qr-codes/${user._id}.png`;
        const qrCodeUrl = await uploadToS3(
            qrBuffer,
            fileKey,
            process.env.AWS_QR_BUCKET_NAME,
            process.env.AWS_QR_BUCKET_REGION,
            'image/png'
        );
        user.qrCode = qrCodeUrl;
        await user.save();

        const html = verificationEmailTemplate(name, code);
        await sendEmail({ email: normalizedEmail, subject: 'Verify Your Email', message: html });

        res.json({ success: true, message: 'Verification email sent' });
    } catch (err) {
        res.status(500).json({ error: 'Registration failed. Try again.' });
    }
};

// VERIFY EMAIL
const verifyEmailCode = async (req, res) => {
    try {
        const email = normalizeEmail(req.body.email);
        const { code } = req.body;
        const user = await User.findOne({ email });

        if (!user) return res.json({ error: 'User not found' });
        if (user.isVerified) return res.json({ error: 'Email already verified' });
        if (user.verificationCode !== code) return res.json({ error: 'Invalid verification code' });
        if (user.verificationCodeExpires < Date.now()) return res.json({ error: 'Code has expired' });

        user.isVerified = true;
        user.verificationCode = undefined;
        user.verificationCodeExpires = undefined;
        await user.save();

        const userToSend = user.toObject({ getters: true, virtuals: true });
        userToSend.id = userToSend._id;
        userToSend.name = userToSend.name || '';
        userToSend.email = userToSend.email || '';

        const token = jwt.sign(
            { email: user.email, id: user._id, name: user.name },
            process.env.JWT_SECRET,
            {}
        );

        res.status(200).json({ success: true, message: 'Email verified successfully', user: userToSend, token });
    } catch {
        res.status(500).json({ error: 'Verification failed' });
    }
};

// RESEND VERIFICATION CODE
const resendVerificationCode = async (req, res) => {
    try {
        const email = normalizeEmail(req.body.email);
        const user = await User.findOne({ email });

        if (!user) return res.json({ error: 'User not found' });
        if (user.isVerified) return res.json({ error: 'Email already verified' });

        const newCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = Date.now() + 10 * 60 * 1000;

        user.verificationCode = newCode;
        user.verificationCodeExpires = expires;
        await user.save();

        const html = verificationEmailTemplate(user.name, newCode);
        await sendEmail({ email, subject: 'Your New Verification Code', message: html });

        res.json({ success: true, message: 'Verification code resent' });
    } catch {
        res.status(500).json({ error: 'Could not resend code' });
    }
};

// LOGIN
const loginUser = async (req, res) => {
    try {
        const email = normalizeEmail(req.body.email);
        const { password } = req.body;

        const user = await User.findOne({ email });
        if (!user) return res.json({ error: 'No user found' });

        const match = await comparePassword(password, user.password);
        if (!match) return res.json({ error: 'Passwords don’t match' });

        if (!user.isVerified) {
            const newCode = Math.floor(100000 + Math.random() * 900000).toString();
            const expires = Date.now() + 10 * 60 * 1000;

            user.verificationCode = newCode;
            user.verificationCodeExpires = expires;
            await user.save();

            const html = verificationEmailTemplate(user.name, newCode);
            await sendEmail({ email, subject: 'Verify Your Email', message: html });

            return res.json({
                error: 'Please verify your email before logging in.',
                resend: true,
            });
        }

        const token = jwt.sign(
            { email: user.email, id: user._id, name: user.name },
            process.env.JWT_SECRET,
            {}
        );

        const userToSend = user.toObject({ getters: true, virtuals: true });
        userToSend.id = userToSend._id;
        userToSend.name = userToSend.name || '';
        userToSend.email = userToSend.email || '';

        res.status(200).json({ user: userToSend, token });
    } catch {
        res.status(500).json({ error: 'Login failed' });
    }
};

// FORGOT PASSWORD
const forgotPassword = async (req, res) => {
    try {
        const email = normalizeEmail(req.body.email);
        const user = await User.findOne({ email });
        if (!user) {
            return res.json({ error: 'User not found' });
        }

        const token = crypto.randomBytes(32).toString('hex');
        user.resetToken = token;
        user.resetTokenExpires = Date.now() + 60 * 60 * 1000;

        try {
            await user.save();
        } catch {
            return res.status(500).json({ error: 'Failed to update user with reset token.' });
        }

        const resetLink = `${process.env.CLIENT_URL}/reset-password/${token}`;
        const html = passwordResetTemplate(user.name, resetLink);
        await sendEmail({ email, subject: 'Reset Your Password', message: html });

        res.json({ success: true, message: 'Password reset email sent' });
    } catch {
        res.status(500).json({ error: 'Could not send password reset email' });
    }
};

// RESET PASSWORD
const resetPassword = async (req, res) => {
    try {
        const { token } = req.params;
        const { password } = req.body;

        const user = await User.findOne({
            resetToken: token,
            resetTokenExpires: { $gt: Date.now() },
        });

        if (!user) {
            return res.json({ error: 'Invalid or expired token' });
        }

        const hashed = await hashPassword(password);
        user.password = hashed;
        user.resetToken = undefined;
        user.resetTokenExpires = undefined;
        await user.save();

        res.json({ success: true, message: 'Password updated successfully' });
    } catch {
        res.status(500).json({ error: 'Password reset failed' });
    }
};

// PROFILE
const getProfile = async (req, res) => {
    if (!req.user || !req.user.id) {
        return res.status(401).json({ error: 'Unauthorized: User ID not found in token.' });
    }

    try {
        const user = await User.findById(req.user.id).select('-password').lean();
        if (!user) return res.status(404).json({ error: 'User not found.' });

        user.id = user._id;
        user.name = user.name || '';
        user.email = user.email || '';
        res.status(200).json({ data: user });
    } catch {
        res.status(500).json({ error: 'Failed to fetch user profile.' });
    }
};

// UPDATE PROFILE
const updateProfile = async (req, res) => {
    if (!req.user || !req.user.id) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const { name, email, bio, job_title, password } = req.body;
        const updateFields = {
            name,
            bio,
            job_title,
            ...(email ? { email: normalizeEmail(email) } : {}),
        };

        if (password) {
            updateFields.password = await hashPassword(password);
        }

        const updatedUser = await User.findByIdAndUpdate(
            req.user.id,
            updateFields,
            { new: true, runValidators: true }
        ).select('-password').lean();

        if (!updatedUser) {
            return res.status(404).json({ error: 'User not found for update.' });
        }

        updatedUser.id = updatedUser._id;
        updatedUser.name = updatedUser.name || '';
        updatedUser.email = updatedUser.email || '';
        res.status(200).json({ success: true, data: updatedUser });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update profile', details: err.message });
    }
};

// DELETE ACCOUNT
const deleteAccount = async (req, res) => {
    if (!req.user || !req.user.id) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        await User.findByIdAndDelete(req.user.id);
        res.status(200).json({ success: true, message: 'Account deleted successfully' });
    } catch {
        res.status(500).json({ error: 'Failed to delete account' });
    }
};

// LOGOUT
const logoutUser = (req, res) => {
    res.status(200).json({ message: 'Logged out successfully' });
};

// STRIPE: Subscribe (recurring)
const subscribeUser = async (req, res) => {
    if (!req.user || !req.user.id) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        let customerId;
        if (user.stripeCustomerId) {
            customerId = user.stripeCustomerId;
        } else {
            const customer = await stripe.customers.create({
                email: user.email,
                name: user.name,
                metadata: { userId: user._id.toString() },
            });
            customerId = customer.id;
            user.stripeCustomerId = customerId;
            await user.save();
        }

        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            payment_method_types: ['card'],
            mode: 'subscription',
            line_items: [{ price: process.env.STRIPE_SUBSCRIPTION_PRICE_ID, quantity: 1 }],
            success_url: `${process.env.CLIENT_URL}/SuccessSubscription?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.CLIENT_URL}/subscription`,
            subscription_data: { trial_period_days: 14 },
        });

        // NEW: create a pending order for this subscription
        try {
            await Order.create({
                userId: user._id,
                type: 'subscription',
                status: 'pending',
                stripeSessionId: session.id,
                stripeCustomerId: customerId,
                // amount/currency will be filled via webhook if you want
            });
        } catch (e) {
            // don't block checkout on order write
            console.error('Failed to create subscription order record:', e.message);
        }

        res.status(200).json({ url: session.url });
    } catch (err) {
        res.status(500).json({ error: 'Failed to start subscription', details: err.message });
    }
};

// STRIPE: Cancel Subscription
const cancelSubscription = async (req, res) => {
    if (!req.user || !req.user.id) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (!user.stripeCustomerId || !user.stripeSubscriptionId) {
            return res.status(400).json({ error: 'No active subscription found for this user.' });
        }
        await stripe.subscriptions.update(user.stripeSubscriptionId, {
            cancel_at_period_end: true,
        });

        res.status(200).json({ success: true, message: 'Subscription will cancel at the end of the current billing period.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to cancel subscription', details: err.message });
    }
};

// STRIPE: Check Subscription Status
const checkSubscriptionStatus = async (req, res) => {
    if (!req.user || !req.user.id) {
        return res.status(200).json({ active: false, status: 'unauthenticated' });
    }

    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(200).json({ active: false, status: 'user_not_found' });

        if (!user.stripeCustomerId || !user.stripeSubscriptionId) {
            return res.status(200).json({ active: false, status: 'no_stripe_data' });
        }

        const subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);

        let isActive = false;
        if (['active', 'trialing', 'past_due', 'unpaid'].includes(subscription.status)) {
            isActive = true;
        }

        if (user.isSubscribed !== isActive) {
            user.isSubscribed = isActive;
            await user.save();
        }

        const responseData = {
            active: isActive,
            status: subscription.status,
            current_period_end: subscription.current_period_end,
        };
        return res.status(200).json(responseData);
    } catch (err) {
        if (err.type === 'StripeInvalidRequestError' && err.raw?.code === 'resource_missing') {
            const user = await User.findById(req.user.id);
            if (user) {
                user.isSubscribed = false;
                user.stripeSubscriptionId = undefined;
                user.stripeCustomerId = undefined;
                await user.save();
            }
            return res.status(200).json({ active: false, status: 'subscription_missing_in_stripe' });
        }
        res.status(500).json({ active: false, status: 'error_checking_stripe', details: err.message });
    }
};

const startTrial = async (req, res) => {
    if (!req.user || !req.user.id) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        if (user.trialExpires) {
            return res.status(400).json({ error: 'Trial has already started.' });
        }

        const fourteenDaysInMilliseconds = 14 * 24 * 60 * 60 * 1000;
        user.trialExpires = new Date(Date.now() + fourteenDaysInMilliseconds);
        user.isSubscribed = false;
        user.trialEmailRemindersSent = [];

        await user.save();

        res.status(200).json({
            success: true,
            message: '14-day free trial started successfully!',
            trialExpires: user.trialExpires,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to start trial', details: err.message });
    }
};

// One-time card checkout
const createCardCheckoutSession = async (req, res) => {
    if (!req.user || !req.user.id) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        if (!process.env.STRIPE_CARD_PRICE_ID) {
            return res.status(500).json({ error: 'Server not configured: STRIPE_CARD_PRICE_ID missing' });
        }

        const rawQty = req.body?.quantity;
        const qty = Math.max(1, parseInt(rawQty, 10) || 1);

        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        let customerId = user.stripeCustomerId;
        if (!customerId) {
            const customer = await stripe.customers.create({
                email: user.email,
                name: user.name,
                metadata: { userId: user._id.toString() },
            });
            customerId = customer.id;
            user.stripeCustomerId = customerId;
            await user.save();
        }

        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            mode: 'payment',
            payment_method_types: ['card'],
            allow_promotion_codes: true,
            line_items: [{ price: process.env.STRIPE_CARD_PRICE_ID, quantity: qty }],
            success_url: `${process.env.CLIENT_URL}/SuccessOrder?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.CLIENT_URL}/productandplan/konarcard`,
            metadata: { userId: user._id.toString(), kind: 'konar_card', quantity: String(qty) },
        });

        // NEW: create a pending order for this card purchase
        try {
            await Order.create({
                userId: user._id,
                type: 'card',
                status: 'pending',
                quantity: qty,
                stripeSessionId: session.id,
                stripeCustomerId: customerId,
                // amountTotal/currency will be filled via webhook if you want
                metadata: { from: 'checkout', product: 'konar_card' },
            });
        } catch (e) {
            console.error('Failed to create card order record:', e.message);
        }

        return res.status(200).json({ id: session.id, url: session.url });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to create checkout session', details: err.message });
    }
};

const submitContactForm = async (req, res) => {
    const { name, email, reason, message } = req.body;

    if (!name || !email || !message || !reason) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    const html = `
    <h2>New Contact Message</h2>
    <p><strong>Name:</strong> ${name}</p>
    <p><strong>Email:</strong> ${email}</p>
    <p><strong>Reason:</strong> ${reason}</p>
    <p><strong>Message:</strong><br/>${message}</p>
  `;

    try {
        await sendEmail({ email: 'supportteam@konarcard.com', subject: `Contact Form: ${reason}`, message: html });
        res.status(200).json({ success: true, message: 'Message sent successfully' });
    } catch {
        res.status(500).json({ error: 'Failed to send message' });
    }
};

module.exports = {
    test,
    registerUser,
    verifyEmailCode,
    resendVerificationCode,
    loginUser,
    forgotPassword,
    resetPassword,
    getProfile,
    logoutUser,
    updateProfile,
    deleteAccount,
    subscribeUser,
    cancelSubscription,
    checkSubscriptionStatus,
    startTrial,
    submitContactForm,
    createCardCheckoutSession,
};
