const { hashPassword, comparePassword, getTokenFromReq } = require('../helpers/auth');
const User = require('../models/user');
const BusinessCard = require('../models/BusinessCard');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const sendEmail = require('../utils/SendEmail');
const { verificationEmailTemplate, passwordResetTemplate } = require('../utils/emailTemplates');
const crypto = require('crypto');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const uploadToS3 = require('../utils/uploadToS3');

const FRONTEND_PROFILE_DOMAIN = process.env.PUBLIC_PROFILE_DOMAIN || 'https://www.konarcard.com';

const signToken = (user) => {
    return jwt.sign(
        { email: user.email, id: user._id, name: user.name },
        process.env.JWT_SECRET
    );
};

const toSafeUser = (userDoc) => {
    const u = userDoc?.toObject ? userDoc.toObject() : userDoc;
    if (!u) return null;
    delete u.password;
    delete u.verificationCode;
    delete u.verificationCodeExpires;
    delete u.resetToken;
    delete u.resetTokenExpires;
    return u;
};

const ensureBusinessCard = async (userId, name = '') => {
    // If your dashboard expects a BusinessCard to exist, create it now.
    await BusinessCard.findOneAndUpdate(
        { user: userId },
        { $setOnInsert: { user: userId, full_name: name || '' } },
        { upsert: true, new: true }
    );
};

const generateAndUploadQr = async (userId, profileUrl) => {
    const qrBuffer = await QRCode.toBuffer(profileUrl, {
        width: 500,
        color: { dark: '#000000', light: '#ffffff' },
    });

    const fileKey = `qr-codes/${userId}.png`;
    const qrCodeUrl = await uploadToS3(qrBuffer, fileKey);
    return qrCodeUrl;
};

// TEST
const test = (req, res) => res.json('test is working');

/**
 * ✅ CLAIM LINK
 * - If NOT logged in: only checks availability and returns ok/available
 * - If logged in (valid JWT + user exists): sets username/slug/profileUrl, generates QR, saves, returns updated user
 * - If token is stale/invalid/user missing: falls back to availability check (prevents "User not found" spam)
 */
const claimLink = async (req, res) => {
    try {
        const raw = (req.body.username || '').trim().toLowerCase();
        if (!raw) return res.status(400).json({ error: 'Username is required' });

        // Basic slug safety
        const safe = raw.replace(/[^a-z0-9._-]/g, '');
        if (safe.length < 3) {
            return res.status(400).json({ error: 'Link name must be at least 3 characters' });
        }

        // Is it already taken?
        const existing = await User.findOne({ username: safe });
        if (existing) return res.status(409).json({ error: 'Username already taken' });

        // If no token -> availability check only
        const token = getTokenFromReq(req);
        if (!token) {
            return res.json({ success: true, available: true, username: safe });
        }

        // If token exists, try to decode it.
        // ✅ If invalid/stale -> DO NOT fail, treat as availability check.
        let decoded = null;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch {
            return res.json({ success: true, available: true, username: safe });
        }

        // Token decoded but user might not exist (deleted account, different DB, etc.)
        // ✅ If missing -> also treat as availability check
        const user = await User.findById(decoded.id);
        if (!user) {
            return res.json({ success: true, available: true, username: safe });
        }

        // Logged in -> set it on the account
        const slug = safe;
        const profileUrl = `${FRONTEND_PROFILE_DOMAIN}/u/${slug}`;

        user.username = safe;
        user.slug = slug;
        user.profileUrl = profileUrl;

        // Generate QR to S3
        const qrCodeUrl = await generateAndUploadQr(user._id, profileUrl);
        user.qrCodeUrl = qrCodeUrl;

        await user.save();
        await ensureBusinessCard(user._id, user.name);

        return res.json({ success: true, user: toSafeUser(user) });
    } catch (err) {
        console.error('claimLink error:', err);
        return res.status(500).json({ error: 'Failed to claim link' });
    }
};


// REGISTER
const registerUser = async (req, res) => {
    try {
        const { name, email, username, password, confirmPassword } = req.body;

        // ✅ confirmPassword optional (frontend currently doesn't send it everywhere)
        if (!name || !email || !username || !password) {
            return res.status(400).json({ error: 'All fields are required.' });
        }
        if (confirmPassword && password !== confirmPassword) {
            return res.status(400).json({ error: 'Passwords do not match.' });
        }

        const cleanEmail = email.trim().toLowerCase();
        const cleanUsername = username.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');

        const existingEmail = await User.findOne({ email: cleanEmail });
        if (existingEmail) return res.json({ error: 'This email is already registered. Please log in.' });

        const existingUsername = await User.findOne({ username: cleanUsername });
        if (existingUsername) return res.status(400).json({ error: 'Username already taken. Please choose another.' });

        const hashedPassword = await hashPassword(password);

        const slug = cleanUsername;
        const profileUrl = `${FRONTEND_PROFILE_DOMAIN}/u/${slug}`;

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = Date.now() + 10 * 60 * 1000;

        const user = await User.create({
            name,
            email: cleanEmail,
            username: cleanUsername,
            password: hashedPassword,
            profileUrl,
            isVerified: false,
            verificationCode: code,
            verificationCodeExpires: expires,
            slug,
            authProvider: 'local',
        });

        const qrCodeUrl = await generateAndUploadQr(user._id, profileUrl);
        user.qrCodeUrl = qrCodeUrl;
        await user.save();

        await ensureBusinessCard(user._id, name);

        const html = verificationEmailTemplate(name, code);
        await sendEmail(cleanEmail, 'Verify Your Email', html);

        res.json({ success: true, message: 'Verification email sent' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Registration failed. Try again.' });
    }
};

// VERIFY EMAIL
const verifyEmailCode = async (req, res) => {
    try {
        const { email, code } = req.body;
        const user = await User.findOne({ email: email.trim().toLowerCase() });

        if (!user) return res.json({ error: 'User not found' });
        if (user.isVerified) return res.json({ error: 'Email already verified' });
        if (user.verificationCode !== code) return res.json({ error: 'Invalid verification code' });
        if (user.verificationCodeExpires < Date.now()) return res.json({ error: 'Code has expired' });

        user.isVerified = true;
        user.verificationCode = undefined;
        user.verificationCodeExpires = undefined;
        await user.save();

        res.json({ success: true, message: 'Email verified successfully' });
    } catch (err) {
        console.log(err);
        res.status(500).json({ error: 'Verification failed' });
    }
};

// RESEND VERIFICATION CODE
const resendVerificationCode = async (req, res) => {
    try {
        const { email } = req.body;
        const user = await User.findOne({ email: email.trim().toLowerCase() });

        if (!user) return res.json({ error: 'User not found' });
        if (user.isVerified) return res.json({ error: 'Email already verified' });

        const newCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = Date.now() + 10 * 60 * 1000;

        user.verificationCode = newCode;
        user.verificationCodeExpires = expires;
        await user.save();

        const html = verificationEmailTemplate(user.name, newCode);
        await sendEmail(user.email, 'Your New Verification Code', html);

        res.json({ success: true, message: 'Verification code resent' });
    } catch (err) {
        console.log(err);
        res.status(500).json({ error: 'Could not resend code' });
    }
};

// LOGIN
const loginUser = async (req, res) => {
    try {
        const { email, password } = req.body;
        const cleanEmail = (email || '').trim().toLowerCase();

        const user = await User.findOne({ email: cleanEmail });
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
            await sendEmail(user.email, 'Verify Your Email', html);

            return res.json({
                error: 'Please verify your email before logging in.',
                resend: true,
            });
        }

        const token = signToken(user);

        // keep cookie if you want (optional)
        res.cookie('token', token, { httpOnly: true, sameSite: 'lax' });

        return res.json({ token, user: toSafeUser(user) });
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: 'Login failed' });
    }
};

// FORGOT PASSWORD
const forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        const cleanEmail = (email || '').trim().toLowerCase();

        const user = await User.findOne({ email: cleanEmail });
        if (!user) return res.json({ error: 'User not found' });

        const token = crypto.randomBytes(32).toString('hex');
        user.resetToken = token;
        user.resetTokenExpires = Date.now() + 60 * 60 * 1000;
        await user.save();

        const resetLink = `${process.env.CLIENT_URL}/reset-password/${token}`;
        const html = passwordResetTemplate(user.name, resetLink);
        await sendEmail(user.email, 'Reset Your Password', html);

        res.json({ success: true, message: 'Password reset email sent' });
    } catch (err) {
        console.log(err);
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

        if (!user) return res.json({ error: 'Invalid or expired token' });

        const hashed = await hashPassword(password);
        user.password = hashed;
        user.resetToken = undefined;
        user.resetTokenExpires = undefined;
        await user.save();

        res.json({ success: true, message: 'Password updated successfully' });
    } catch (err) {
        console.log(err);
        res.status(500).json({ error: 'Password reset failed' });
    }
};

// PROFILE (✅ supports bearer OR cookie, and returns {data:user} to match frontend)
const getProfile = async (req, res) => {
    const token = getTokenFromReq(req);
    if (!token) return res.json({ data: null });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id).select('-password');
        res.json({ data: toSafeUser(user) });
    } catch {
        res.json({ data: null });
    }
};

// UPDATE PROFILE (bearer/cookie)
const updateProfile = async (req, res) => {
    try {
        const token = getTokenFromReq(req);
        if (!token) return res.status(401).json({ error: 'Unauthorized' });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const { name, email, bio, job_title } = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            decoded.id,
            { name, email, bio, job_title },
            { new: true, runValidators: true }
        ).select('-password');

        res.json({ success: true, user: toSafeUser(updatedUser) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update profile' });
    }
};

// DELETE ACCOUNT (bearer/cookie)
const deleteAccount = async (req, res) => {
    try {
        const token = getTokenFromReq(req);
        if (!token) return res.status(401).json({ error: 'Unauthorized' });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        await User.findByIdAndDelete(decoded.id);
        res.clearCookie('token').json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete account' });
    }
};

// LOGOUT
const logoutUser = (req, res) => {
    res.clearCookie('token');
    res.json({ message: 'Logged out successfully' });
};

// STRIPE: Subscribe (bearer/cookie)
const subscribeUser = async (req, res) => {
    const token = getTokenFromReq(req);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id);

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'subscription',
            line_items: [{ price: process.env.STRIPE_SUBSCRIPTION_PRICE_ID, quantity: 1 }],
            success_url: req.body.returnUrl || 'http://localhost:5173/success',
            cancel_url: 'http://localhost:5173/subscription',
            customer_email: user.email,
        });

        res.json({ url: session.url });
    } catch (err) {
        console.error('Subscription error:', err);
        res.status(500).json({ error: 'Failed to start subscription' });
    }
};

// STRIPE: Cancel Subscription (bearer/cookie)
const cancelSubscription = async (req, res) => {
    const token = getTokenFromReq(req);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id);

        if (!user.stripeCustomerId) return res.status(400).json({ error: 'No subscription found' });

        const subscriptions = await stripe.subscriptions.list({
            customer: user.stripeCustomerId,
            status: 'active',
            limit: 1,
        });

        if (subscriptions.data.length === 0) return res.json({ error: 'No active subscription found' });

        await stripe.subscriptions.update(subscriptions.data[0].id, {
            cancel_at_period_end: true,
        });

        res.json({ success: true, message: 'Subscription will cancel at period end' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to cancel subscription' });
    }
};

// STRIPE: Check Subscription Status (bearer/cookie)
const checkSubscriptionStatus = async (req, res) => {
    const token = getTokenFromReq(req);
    if (!token) return res.json({ active: false });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id);
        res.json({ active: user?.isSubscribed || false });
    } catch (err) {
        console.error('Error checking subscription status:', err);
        res.json({ active: false });
    }
};

// CONTACT FORM
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
        await sendEmail('supportteam@konarcard.com', `Contact Form: ${reason}`, html);
        res.json({ success: true, message: 'Message sent successfully' });
    } catch (err) {
        console.error('Error sending contact form email:', err);
        res.status(500).json({ error: 'Failed to send message' });
    }
};

module.exports = {
    test,
    claimLink,
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
    submitContactForm,
};
