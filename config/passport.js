const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User = require('../models/user');

module.exports = function configurePassport() {
    if (
        !process.env.GOOGLE_CLIENT_ID ||
        !process.env.GOOGLE_CLIENT_SECRET ||
        !process.env.GOOGLE_CALLBACK_URL
    ) {
        console.warn('⚠️ Google OAuth env vars missing. Google login will not work.');
        return;
    }

    passport.use(
        new GoogleStrategy(
            {
                clientID: process.env.GOOGLE_CLIENT_ID,
                clientSecret: process.env.GOOGLE_CLIENT_SECRET,
                callbackURL: process.env.GOOGLE_CALLBACK_URL,
            },
            async (accessToken, refreshToken, profile, done) => {
                try {
                    const email = profile?.emails?.[0]?.value?.toLowerCase() || null;
                    const name = profile?.displayName || '';
                    const googleId = profile?.id || null;

                    if (!email || !googleId) {
                        return done(null, false, { message: 'Google account missing email or id.' });
                    }

                    // 1) If someone already has this googleId, use them
                    let user = await User.findOne({ googleId });

                    // 2) Otherwise link by email if account exists
                    if (!user) {
                        user = await User.findOne({ email });
                    }

                    // 3) Create new user if needed (IMPORTANT: don't set profileUrl/slug/username at all)
                    if (!user) {
                        user = await User.create({
                            name,
                            email,
                            password: undefined,
                            isVerified: true,
                            googleId,
                            authProvider: 'google',
                            // DO NOT set profileUrl/slug/username here (they'll claim later)
                        });
                    } else {
                        // ensure it's linked + verified
                        let changed = false;

                        if (!user.googleId) {
                            user.googleId = googleId;
                            changed = true;
                        }
                        if (!user.isVerified) {
                            user.isVerified = true;
                            changed = true;
                        }
                        if (!user.authProvider || user.authProvider === 'local') {
                            user.authProvider = 'google';
                            changed = true;
                        }
                        if (changed) await user.save();
                    }

                    return done(null, user);
                } catch (err) {
                    return done(err);
                }
            }
        )
    );
};
