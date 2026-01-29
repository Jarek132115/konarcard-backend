const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User = require('../models/user');

module.exports = function configurePassport() {
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
                    const googleId = profile?.id;

                    if (!email) {
                        return done(null, false, { message: 'Google account has no email.' });
                    }

                    // Find existing user by email first
                    let user = await User.findOne({ email });

                    if (!user) {
                        // Create a new user WITHOUT username/slug yet
                        user = await User.create({
                            name,
                            email,
                            password: null,
                            isVerified: true, // OAuth users are considered verified
                            googleId,
                        });
                    } else {
                        // Link googleId if missing
                        if (!user.googleId) {
                            user.googleId = googleId;
                            user.isVerified = true;
                            await user.save();
                        }
                    }

                    return done(null, user);
                } catch (err) {
                    return done(err);
                }
            }
        )
    );

    // We are NOT using sessions, so no serialize/deserialize needed.
};
