const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User = require('../models/user');

module.exports = function configurePassport() {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_CALLBACK_URL) {
        console.warn('⚠️ Google OAuth env vars missing. Google login will not work.');
        return;
    }

    passport.use(
        new GoogleStrategy(
            {
                clientID: process.env.GOOGLE_CLIENT_ID,
                clientSecret: process.env.GOOGLE_CLIENT_SECRET,
                callbackURL: process.env.GOOGLE_CALLBACK_URL, // must match Google console
            },
            async (accessToken, refreshToken, profile, done) => {
                try {
                    const email = profile?.emails?.[0]?.value?.toLowerCase() || null;
                    const name = profile?.displayName || '';
                    const googleId = profile?.id;

                    if (!email) return done(null, false, { message: 'Google account has no email.' });

                    let user = await User.findOne({ email });

                    if (!user) {
                        user = await User.create({
                            name,
                            email,
                            password: null,
                            isVerified: true,
                            googleId,
                            authProvider: 'google',
                        });
                    } else {
                        // link google to existing account
                        let changed = false;

                        if (!user.googleId) {
                            user.googleId = googleId;
                            changed = true;
                        }
                        if (!user.isVerified) {
                            user.isVerified = true;
                            changed = true;
                        }
                        if (user.authProvider !== 'google') {
                            user.authProvider = user.authProvider || 'google';
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
