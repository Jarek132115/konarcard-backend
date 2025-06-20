const { hashPassword, comparePassword } = require('../helpers/auth');
const User = require('../models/user');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const sendEmail = require('../utils/sendEmail');
const { verificationEmailTemplate, passwordResetTemplate } = require('../utils/emailTemplates');
const crypto = require('crypto');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const uploadToS3 = require('../utils/uploadToS3');

// REMOVED: Multer and S3 imports (multer, PutObjectCommand, S3Client, path, uuidv4)
// as uploadAvatar function will be moved/handled elsewhere if needed.

// TEST route
const test = (req, res) => {
    res.json('Test is working from authController (using Authorization Header)!');
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
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        }

        const existingEmail = await User.findOne({ email });
        if (existingEmail) return res.status(400).json({ error: 'This email is already registered. Please log in.' });

        const existingUsername = await User.findOne({ username: username.toLowerCase() });
        if (existingUsername) return res.status(400).json({ error: 'Username already taken. Please choose another.' });

        const hashedPassword = await hashPassword(password);

        const slug = username.toLowerCase();
        const profileUrl = `https://konarcard.com/u/${slug}`;
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
            color: { dark: '#000000', light: '#ffffff' },
        });
        const fileKey = `qr-codes/${user._id}.png`;
        const qrCodeUrl = await uploadToS3(qrBuffer, fileKey, process.env.AWS_CARD_BUCKET_NAME, process.env.AWS_CARD_BUCKET_REGION);
        user.qrCodeUrl = qrCodeUrl;
        await user.save();

        const html = verificationEmailTemplate(name, code);
        await sendEmail(email, 'Verify Your Email', html);

        res.json({ success: true, message: 'Verification email sent' });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ error: 'Registration failed. Try again.' });
    }
};

// VERIFY EMAIL with code
const verifyEmailCode = async (req, res) => {
    try {
        const { email, code } = req.body;
        const user = await User.findOne({ email });

        if (!user) return res.status(404).json({ error: 'User not found.' });
        if (user.isVerified) return res.status(400).json({ error: 'Email already verified.' });
        if (user.verificationCode !== code) return res.status(400).json({ error: 'Invalid verification code.' });
        if (user.verificationCodeExpires < Date.now()) return res.status(400).json({ error: 'Verification code has expired.' });

        user.isVerified = true;
        user.verificationCode = undefined;
        user.verificationCodeExpires = undefined;
        await user.save();

        res.json({ success: true, message: 'Email verified successfully!' });
    } catch (err) {
        console.error('Email verification error:', err);
        res.status(500).json({ error: 'Email verification failed.' });
    }
};

// RESEND VERIFICATION CODE
const resendVerificationCode = async (req, res) => {
    try {
        const { email } = req.body;
        const user = await User.findOne({ email });

        if (!user) return res.status(404).json({ error: 'User not found.' });
        if (user.isVerified) return res.status(400).json({ error: 'Email already verified.' });

        const newCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = Date.now() + 10 * 60 * 1000;

        user.verificationCode = newCode;
        user.verificationCodeExpires = expires;
        await user.save();

        const html = verificationEmailTemplate(user.name, newCode);
        await sendEmail(email, 'Your New Verification Code', html);

        res.json({ success: true, message: 'New verification code sent to your email.' });
    } catch (err) {
        console.error('Resend verification code error:', err);
        res.status(500).json({ error: 'Could not resend verification code.' });
    }
};

// LOGIN user
const loginUser = async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });

        if (!user) return res.status(404).json({ error: 'No user found with that email.' });
        const match = await comparePassword(password, user.password);
        if (!match) return res.status(401).json({ error: 'Incorrect password.' });

        if (!user.isVerified) {
            const newCode = Math.floor(100000 + Math.random() * 900000).toString();
            const expires = Date.now() + 10 * 60 * 1000;
            user.verificationCode = newCode;
            user.verificationCodeExpires = expires;
            await user.save();
            const html = verificationEmailTemplate(user.name, newCode);
            await sendEmail(email, 'Verify Your Email', html);
            return res.status(403).json({
                error: 'Please verify your email address before logging in.',
                resend: true,
            });
        }

        // Generate JWT token
        jwt.sign(
            { email: user.email, id: user._id, name: user.name, username: user.username }, // Include username in token
            process.env.JWT_SECRET,
            { expiresIn: '7d' }, // Token valid for 7 days
            (err, token) => {
                if (err) {
                    console.error('JWT sign error:', err);
                    return res.status(500).json({ error: 'Failed to generate authentication token.' });
                }
                // REMOVED: res.cookie(). Now sending token in response body.
                res.json({ success: true, user: user, token: token }); // Send token in response body
            }
        );
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
};

// Middleware to extract and verify JWT (Concept - not part of export but for internal use)
// This logic will be integrated into the start of protected routes, or you can create a separate middleware file.
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: No token provided or malformed.' });
    }

    const token = authHeader.split(' ')[1];

    if (!token) { // Should be caught by startsWith check, but good for explicit safety
        return res.status(401).json({ error: 'Unauthorized: Token missing.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // Attach decoded user data to request object
        next(); // Proceed to the route handler
    } catch (err) {
        console.error('JWT verification failed:', err);
        return res.status(403).json({ error: 'Forbidden: Invalid or expired token.' });
    }
};


// FORGOT PASSWORD
const forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        const user = await User.findOne({ email });
        if (!user) return res.status(404).json({ error: 'User not found.' });

        const resetToken = crypto.randomBytes(32).toString('hex');
        user.resetPasswordToken = resetToken;
        user.resetPasswordExpires = Date.now() + 60 * 60 * 1000;
        await user.save();

        const resetLink = `${process.env.CLIENT_URL}/reset-password/${resetToken}`;
        const html = passwordResetTemplate(user.name, resetLink);
        await sendEmail(email, 'Reset Your Password for KonarCard', html);

        res.json({ success: true, message: 'Password reset link sent to your email.' });
    } catch (err) {
        console.error('Forgot password error:', err);
        res.status(500).json({ error: 'Could not send password reset email.' });
    }
};

// RESET PASSWORD
const resetPassword = async (req, res) => {
    try {
        const { token } = req.params;
        const { password } = req.body;

        const user = await User.findOne({
            resetPasswordToken: token,
            resetPasswordExpires: { $gt: Date.now() },
        });

        if (!user) return res.status(400).json({ error: 'Invalid or expired password reset token.' });

        if (!password || password.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters.' });
        }

        const hashedPassword = await hashPassword(password);
        user.password = hashedPassword;
        user.resetPasswordToken = undefined;
        user.resetPasswordExpires = undefined;
        await user.save();

        res.json({ success: true, message: 'Your password has been updated successfully.' });
    } catch (err) {
        console.error('Reset password error:', err);
        res.status(500).json({ error: 'Password reset failed.' });
    }
};

// GET PROFILE (authenticated user)
const getProfile = async (req, res) => {
    // Authenticate token directly in this function (or use middleware)
    authenticateToken(req, res, async () => {
        try {
            // req.user is populated by authenticateToken middleware
            const user = await User.findById(req.user.id).select('-password');
            if (!user) {
                // If user not found in DB despite valid token, this is an inconsistency
                return res.status(404).json({ error: 'User not found in database.' });
            }
            res.json(user);
        } catch (err) {
            console.error('Get profile error:', err);
            res.status(500).json({ error: 'Failed to fetch profile data.' });
        }
    });
};

// UPDATE PROFILE (authenticated user)
const updateProfile = async (req, res) => {
    authenticateToken(req, res, async () => {
        try {
            const userId = req.user.id; // User ID from decoded token
            const { name, email, bio, job_title, username } = req.body;

            if (email && email !== req.user.email) {
                const existingEmailUser = await User.findOne({ email });
                if (existingEmailUser && existingEmailUser._id.toString() !== userId) {
                    return res.status(400).json({ error: 'Email already taken by another user.' });
                }
            }
            if (username && username.toLowerCase() !== req.user.username?.toLowerCase()) {
                const existingUsernameUser = await User.findOne({ username: username.toLowerCase() });
                if (existingUsernameUser && existingUsernameUser._id.toString() !== userId) {
                    return res.status(400).json({ error: 'Username already taken by another user.' });
                }
            }

            const updateFields = { name, email, bio, job_title };
            if (username) updateFields.username = username.toLowerCase().trim();

            const updatedUser = await User.findByIdAndUpdate(
                userId,
                updateFields,
                { new: true, runValidators: true }
            ).select('-password');

            if (!updatedUser) return res.status(404).json({ error: 'User not found for update.' });

            res.json({ success: true, user: updatedUser });
        } catch (err) {
            console.error('Update profile error:', err);
            res.status(500).json({ error: 'Failed to update profile.' });
        }
    });
};

// DELETE ACCOUNT (authenticated user)
const deleteAccount = async (req, res) => {
    authenticateToken(req, res, async () => {
        try {
            const userId = req.user.id;

            const deletedUser = await User.findByIdAndDelete(userId);
            if (!deletedUser) return res.status(404).json({ error: 'User not found for deletion.' });

            res.json({ success: true, message: 'Account deleted successfully.' }); // No cookie to clear
        } catch (err) {
            console.error('Delete account error:', err);
            res.status(500).json({ error: 'Failed to delete account.' });
        }
    });
};

// LOGOUT user
const logoutUser = (req, res) => {
    // No cookie to clear from backend as JWT is in localStorage
    res.json({ message: 'Logged out successfully.' });
};

// STRIPE: Subscribe user
const subscribeUser = async (req, res) => {
    authenticateToken(req, res, async () => {
        try {
            const user = await User.findById(req.user.id);
            if (!user) return res.status(404).json({ error: 'User not found.' });

            const session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                mode: 'subscription',
                line_items: [{
                    price: process.env.STRIPE_SUBSCRIPTION_PRICE_ID,
                    quantity: 1,
                }],
                success_url: req.body.returnUrl || 'https://konarcard.com/success',
                cancel_url: 'https://konarcard.com/subscription',
                customer_email: user.email,
                client_reference_id: user._id.toString(),
            });

            res.json({ url: session.url });
        } catch (err) {
            console.error('Stripe subscribe error:', err);
            res.status(500).json({ error: 'Failed to initiate subscription.' });
        }
    });
};

// STRIPE: Cancel Subscription
const cancelSubscription = async (req, res) => {
    authenticateToken(req, res, async () => {
        try {
            const user = await User.findById(req.user.id);
            if (!user) return res.status(404).json({ error: 'User not found.' });

            if (!user.stripeCustomerId) return res.status(400).json({ error: 'No active subscription found for this user.' });

            const subscriptions = await stripe.subscriptions.list({
                customer: user.stripeCustomerId,
                status: 'active',
                limit: 1,
            });

            if (subscriptions.data.length === 0) return res.status(404).json({ error: 'No active subscription found to cancel.' });

            await stripe.subscriptions.update(subscriptions.data[0].id, {
                cancel_at_period_end: true,
            });

            res.json({ success: true, message: 'Subscription will be canceled at the end of the current billing period.' });
        } catch (err) {
            console.error('Stripe cancel subscription error:', err);
            res.status(500).json({ error: 'Failed to cancel subscription.' });
        }
    });
};

// STRIPE: Check Subscription Status
const checkSubscriptionStatus = async (req, res) => {
    // This route does not require authentication to return 'false' if no token.
    // So, we don't apply authenticateToken middleware here.
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.json({ active: false });
    }
    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id);
        if (!user) return res.json({ active: false });

        res.json({ active: user?.isSubscribed || false });
    } catch (err) {
        console.error('Stripe check subscription status error (JWT invalid/expired):', err);
        return res.json({ active: false });
    }
};

// CONTACT FORM submission
const submitContactForm = async (req, res) => {
    const { name, email, reason, message } = req.body;

    if (!name || !email || !message || !reason) {
        return res.status(400).json({ error: 'All fields are required for the contact form.' });
    }

    const html = `
    <h2>New Contact Message from KonarCard</h2>
    <p><strong>Name:</strong> ${name}</p>
    <p><strong>Email:</strong> ${email}</p>
    <p><strong>Reason:</strong> ${reason}</p>
    <p><strong>Message:</strong><br/>${message}</p>
    `;

    try {
        await sendEmail('supportteam@konarcard.com', `Contact Form: ${reason}`, html);
        res.json({ success: true, message: 'Your message has been sent successfully!' });
    } catch (err) {
        console.error('Contact form email sending error:', err);
        res.status(500).json({ error: 'Failed to send your message. Please try again.' });
    }
};

// Export all functions
module.exports = {
    test,
    registerUser,
    verifyEmailCode,
    resendVerificationCode,
    loginUser,
    forgotPassword,
    resetPassword,
    getProfile,
    updateProfile,
    deleteAccount,
    logoutUser,
    // REMOVED uploadAvatar from export as it's not a core auth function.
    // If needed, it should be in a separate user management controller/route.
    subscribeUser,
    cancelSubscription,
    checkSubscriptionStatus,
    submitContactForm,
};