const { hashPassword, comparePassword } = require('../helpers/auth');
const User = require('../models/user');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const sendEmail = require('../utils/SendEmail');
const { verificationEmailTemplate, passwordResetTemplate } = require('../utils/emailTemplates');
const crypto = require('crypto');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const uploadToS3 = require('../utils/uploadToS3');

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

        const existingEmail = await User.findOne({ email });
        if (existingEmail) return res.json({ error: 'This email is already registered. Please log in.' });

        const existingUsername = await User.findOne({ username: username.toLowerCase() });
        if (existingUsername) return res.status(400).json({ error: 'Username already taken. Please choose another.' });

        const hashedPassword = await hashPassword(password);

        const slug = username.toLowerCase();
        const profileUrl = `${process.env.CLIENT_URL}/u/${slug}`;
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = Date.now() + 10 * 60 * 1000;

        const user = await User.create({
            name,
            email,
            username: username.toLowerCase().trim(),
            password: hashedPassword,
            profileUrl,
            isVerified: false,
            verificationCode: code,
            verificationCodeExpires: expires,
            slug,
        });

        const qrBuffer = await QRCode.toBuffer(profileUrl, {
            width: 500,
            color: {
                dark: '#000000',
                light: '#ffffff',
            },
        });

        const fileKey = `qr-codes/${user._id}.png`;
        const qrCodeUrl = await uploadToS3(qrBuffer, fileKey, process.env.AWS_QR_BUCKET_NAME, process.env.AWS_QR_BUCKET_REGION, 'image/png');
        user.qrCode = qrCodeUrl;
        await user.save();

        const html = verificationEmailTemplate(name, code);
        await sendEmail({ email: email, subject: 'Verify Your Email', message: html });

        res.json({ success: true, message: 'Verification email sent' });
    } catch (err) {
        console.error("Backend Register Error:", err);
        res.status(500).json({ error: 'Registration failed. Try again.' });
    }
};

// VERIFY EMAIL
const verifyEmailCode = async (req, res) => {
    try {
        const { email, code } = req.body;
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

        res.status(200).json({ success: true, message: 'Email verified successfully', data: userToSend });

    } catch (err) {
        console.log(err);
        res.status(500).json({ error: 'Verification failed' });
    }
};

// RESEND VERIFICATION CODE
const resendVerificationCode = async (req, res) => {
    try {
        const { email } = req.body;
        const user = await User.findOne({ email });

        if (!user) return res.json({ error: 'User not found' });
        if (user.isVerified) return res.json({ error: 'Email already verified' });

        const newCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = Date.now() + 10 * 60 * 1000;

        user.verificationCode = newCode;
        user.verificationCodeExpires = expires;
        await user.save();

        const html = verificationEmailTemplate(user.name, newCode);
        await sendEmail({ email: email, subject: 'Your New Verification Code', message: html });

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
            await sendEmail({ email: email, subject: 'Verify Your Email', message: html });

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

    } catch (error) {
        console.error("Backend Login Error:", error);
        res.status(500).json({ error: 'Login failed' });
    }
};

// FORGOT PASSWORD
const forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        const user = await User.findOne({ email });
        if (!user) return res.json({ error: 'User not found' });

        const token = crypto.randomBytes(32).toString('hex');
        user.resetToken = token;
        user.resetTokenExpires = Date.now() + 60 * 60 * 1000; // Token expires in 1 hour
        await user.save();

        const resetLink = `${process.env.CLIENT_URL}/reset-password/${token}`;
        const html = passwordResetTemplate(user.name, resetLink);
        await sendEmail({ email: email, subject: 'Reset Your Password', message: html });

        res.json({ success: true, message: 'Password reset email sent' });
    } catch (err) {
        console.log(err);
        res.status(500).json({ error: 'Could not send password reset email' });
    }
};

// RESET PASSWORD
const resetPassword = async (req, res) => {
    try {
        const { token } = req.params; // Token from URL parameters
        const { password } = req.body; // New password from request body

        console.log(`[RESET PASSWORD DEBUG] Received token from URL: ${token}`);
        console.log(`[RESET PASSWORD DEBUG] Received new password (length): ${password ? password.length : 'N/A'}`);
        console.log(`[RESET PASSWORD DEBUG] Current server Date.now(): ${Date.now()}`);

        const user = await User.findOne({
            resetToken: token,
            resetTokenExpires: { $gt: Date.now() }, // Check if token is not expired
        });

        if (!user) {
            // If user is not found, let's try to find them by token alone to see if it's an expiry issue
            const userWithToken = await User.findOne({ resetToken: token });
            if (userWithToken) {
                console.log(`[RESET PASSWORD DEBUG] User found by token, but token is expired.`);
                console.log(`[RESET PASSWORD DEBUG] User's stored resetTokenExpires: ${userWithToken.resetTokenExpires}`);
                console.log(`[RESET PASSWORD DEBUG] Time difference (ms): ${Date.now() - userWithToken.resetTokenExpires}`);
            } else {
                console.log(`[RESET PASSWORD DEBUG] No user found with the provided token at all.`);
            }
            return res.json({ error: 'Invalid or expired token' });
        }

        console.log(`[RESET PASSWORD DEBUG] User found for reset: ${user.email}`);
        console.log(`[RESET PASSWORD DEBUG] User's stored resetToken: ${user.resetToken}`);
        console.log(`[RESET PASSWORD DEBUG] User's stored resetTokenExpires: ${user.resetTokenExpires}`);

        const hashed = await hashPassword(password);
        user.password = hashed;
        user.resetToken = undefined; // Clear the token after use
        user.resetTokenExpires = undefined; // Clear the expiry after use
        await user.save();

        res.json({ success: true, message: 'Password updated successfully' });
    } catch (err) {
        console.error(`[RESET PASSWORD ERROR]`, err); // Log the full error
        res.status(500).json({ error: 'Password reset failed' });
    }
};

// PROFILE
const getProfile = async (req, res) => {
    if (!req.user || !req.user.id) {
        console.warn("Backend /profile: No req.user.id found from token.");
        return res.status(401).json({ error: 'Unauthorized: User ID not found in token.' });
    }

    try {
        const user = await User.findById(req.user.id).select('-password').lean();

        if (!user) {
            console.warn(`Backend /profile: User with ID ${req.user.id} not found in DB.`);
            return res.status(404).json({ error: 'User not found.' });
        }

        user.id = user._id;
        user.name = user.name || '';
        user.email = user.email || '';

        res.status(200).json({ data: user });

    } catch (err) {
        console.error("Backend /profile error:", err);
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
        const updateFields = { name, email, bio, job_title };

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
        console.error('Backend: Error updating profile:', err);
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
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete account' });
    }
};

// LOGOUT
const logoutUser = (req, res) => {
    res.status(200).json({ message: 'Logged out successfully' });
};

// STRIPE: Subscribe
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
            console.log(`Backend: Created new Stripe customer: ${customerId} for user ${user._id}`);
        }

        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            payment_method_types: ['card'],
            mode: 'subscription',
            line_items: [{
                price: process.env.STRIPE_SUBSCRIPTION_PRICE_ID,
                quantity: 1,
            }],

            success_url: `${process.env.CLIENT_URL}/SuccessSubscription?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.CLIENT_URL}/pricing`,

            subscription_data: {
                trial_period_days: 7,
            },
        });

        res.status(200).json({ url: session.url });
    } catch (err) {
        console.error('Backend: Subscription error:', err);
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

        const subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);

        await stripe.subscriptions.update(user.stripeSubscriptionId, {
            cancel_at_period_end: true,
        });

        res.status(200).json({ success: true, message: 'Subscription will cancel at the end of the current billing period.' });
    } catch (err) {
        console.error('Backend: Error canceling subscription:', err);
        res.status(500).json({ error: 'Failed to cancel subscription', details: err.message });
    }
};

// STRIPE: Check Subscription Status
const checkSubscriptionStatus = async (req, res) => {
    if (!req.user || !req.user.id) {
        console.log("Backend: /subscription-status - No user authenticated. Returning active: false.");
        return res.status(200).json({ active: false, status: 'unauthenticated' });
    }

    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            console.log(`Backend: /subscription-status - User ${req.user.id} not found in DB. Returning active: false.`);
            return res.status(200).json({ active: false, status: 'user_not_found' });
        }

        console.log(`Backend: /subscription-status - User ${user._id} DB status: isSubscribed=${user.isSubscribed}, stripeCustomerId=${user.stripeCustomerId}, stripeSubscriptionId=${user.stripeSubscriptionId}`);

        if (!user.stripeCustomerId || !user.stripeSubscriptionId) {
            console.log(`Backend: /subscription-status - No Stripe customer/subscription ID found for user ${user._id}. Returning active: false.`);
            return res.status(200).json({ active: false, status: 'no_stripe_data' });
        }

        const subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
        console.log(`Backend: /subscription-status - Stripe subscription status for ${user.stripeSubscriptionId}: ${subscription.status}`);

        let isActive = false;
        if (['active', 'trialing', 'past_due', 'unpaid'].includes(subscription.status)) {
            isActive = true;
        }

        if (user.isSubscribed !== isActive) {
            user.isSubscribed = isActive;
            await user.save();
            console.log(`Backend: /subscription-status - Updated user ${user._id} isSubscribed status in DB to ${isActive}.`);
        }

        const responseData = {
            active: isActive,
            status: subscription.status,
            current_period_end: subscription.current_period_end
        };
        console.log("Backend: /subscription-status - Sending response:", responseData);
        return res.status(200).json(responseData);

    } catch (err) {
        console.error('Backend: Error checking subscription status:', err);
        if (err.type === 'StripeInvalidRequestError' && err.raw?.code === 'resource_missing') {
            console.warn(`Backend: /subscription-status - Stripe subscription resource missing for user ${req.user.id}. Marking as not subscribed.`);
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
        await sendEmail({ email: 'supportteam@konarcard.com', subject: `Contact Form: ${reason}`, message: html });
        res.status(200).json({ success: true, message: 'Message sent successfully' });
    } catch (err) {
        console.error('Error sending contact form email:', err);
        res.status(500).json({ error: 'Failed to send message' });
    }
};

// EXPORT ALL
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
    submitContactForm,
};