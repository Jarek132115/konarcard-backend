const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const FacebookStrategy = require('passport-facebook').Strategy;
const User = require('../models/user');

module.exports = function configurePassport() {
    // ---------- GOOGLE ----------
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_CALLBACK_URL) {
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

                        let user = await User.findOne({ googleId });
                        if (!user) user = await User.findOne({ email });

                        if (!user) {
                            user = await User.create({
                                name,
                                email,
                                password: undefined,
                                isVerified: true,
                                googleId,
                                authProvider: 'google',
                            });
                        } else {
                            let changed = false;
                            if (!user.googleId) { user.googleId = googleId; changed = true; }
                            if (!user.isVerified) { user.isVerified = true; changed = true; }
                            if (!user.authProvider || user.authProvider === 'local') { user.authProvider = 'google'; changed = true; }
                            if (changed) await user.save();
                        }

                        return done(null, user);
                    } catch (err) {
                        return done(err);
                    }
                }
            )
        );
    } else {
        console.warn('⚠️ Google OAuth env vars missing. Google login will not work.');
    }

    // ---------- FACEBOOK ----------
    if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET && process.env.FACEBOOK_CALLBACK_URL) {
        passport.use(
            new FacebookStrategy(
                {
                    clientID: process.env.FACEBOOK_APP_ID,
                    clientSecret: process.env.FACEBOOK_APP_SECRET,
                    callbackURL: process.env.FACEBOOK_CALLBACK_URL,
                    profileFields: ['id', 'displayName', 'emails'], // ✅ request email
                },
                async (accessToken, refreshToken, profile, done) => {
                    try {
                        const facebookId = profile?.id || null;
                        const name = profile?.displayName || '';
                        const email = profile?.emails?.[0]?.value?.toLowerCase() || null;

                        // Facebook may not return email if it's not available/verified or permissions not granted.
                        if (!facebookId) {
                            return done(null, false, { message: 'Facebook account missing id.' });
                        }
                        if (!email) {
                            return done(null, false, { message: 'Facebook account did not provide an email address.' });
                        }

                        let user = await User.findOne({ facebookId });
                        if (!user) user = await User.findOne({ email });

                        if (!user) {
                            user = await User.create({
                                name,
                                email,
                                password: undefined,
                                isVerified: true,
                                facebookId,
                                authProvider: 'facebook',
                                // DO NOT set username/slug/profileUrl here (claim later)
                            });
                        } else {
                            let changed = false;
                            if (!user.facebookId) { user.facebookId = facebookId; changed = true; }
                            if (!user.isVerified) { user.isVerified = true; changed = true; }
                            if (!user.authProvider || user.authProvider === 'local') { user.authProvider = 'facebook'; changed = true; }
                            if (changed) await user.save();
                        }

                        return done(null, user);
                    } catch (err) {
                        return done(err);
                    }
                }
            )
        );
    } else {
        console.warn('⚠️ Facebook OAuth env vars missing. Facebook login will not work.');
    }
};
