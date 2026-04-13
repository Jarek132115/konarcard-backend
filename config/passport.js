const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const FacebookStrategy = require("passport-facebook").Strategy;
const AppleStrategy = require("passport-apple");
const User = require("../models/user");
const sendEmail = require("../utils/SendEmail");
const { welcomeEmailTemplate } = require("../utils/emailTemplates");

function fireWelcomeEmail(user) {
    if (!user?.email) return;
    sendEmail(user.email, "Welcome to KonarCard!", welcomeEmailTemplate(user.name))
        .catch((err) => console.error("[OAuth] welcome email failed:", err?.message || err));
}

module.exports = function configurePassport() {
    // ---------- GOOGLE ----------
    if (
        process.env.GOOGLE_CLIENT_ID &&
        process.env.GOOGLE_CLIENT_SECRET &&
        process.env.GOOGLE_CALLBACK_URL
    ) {
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
                        const name = profile?.displayName || "";
                        const googleId = profile?.id || null;

                        if (!email || !googleId) {
                            return done(null, false, {
                                message: "Google account missing email or id.",
                            });
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
                                authProvider: "google",
                            });
                            fireWelcomeEmail(user);
                        } else {
                            let changed = false;

                            if (!user.googleId) {
                                user.googleId = googleId;
                                changed = true;
                            }

                            if (!user.isVerified) {
                                user.isVerified = true;
                                changed = true;
                            }

                            if (!user.authProvider || user.authProvider === "local") {
                                user.authProvider = "google";
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
    } else {
        console.warn("⚠️ Google OAuth env vars missing. Google login will not work.");
    }

    // ---------- FACEBOOK ----------
    if (
        process.env.FACEBOOK_APP_ID &&
        process.env.FACEBOOK_APP_SECRET &&
        process.env.FACEBOOK_CALLBACK_URL
    ) {
        passport.use(
            new FacebookStrategy(
                {
                    clientID: process.env.FACEBOOK_APP_ID,
                    clientSecret: process.env.FACEBOOK_APP_SECRET,
                    callbackURL: process.env.FACEBOOK_CALLBACK_URL,
                    profileFields: ["id", "displayName", "emails"],
                },
                async (accessToken, refreshToken, profile, done) => {
                    try {
                        const facebookId = profile?.id || null;
                        const name = profile?.displayName || "";
                        const email = profile?.emails?.[0]?.value?.toLowerCase() || null;

                        if (!facebookId) {
                            return done(null, false, {
                                message: "Facebook account missing id.",
                            });
                        }

                        if (!email) {
                            return done(null, false, {
                                message: "Facebook account did not provide an email address.",
                            });
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
                                authProvider: "facebook",
                            });
                            fireWelcomeEmail(user);
                        } else {
                            let changed = false;

                            if (!user.facebookId) {
                                user.facebookId = facebookId;
                                changed = true;
                            }

                            if (!user.isVerified) {
                                user.isVerified = true;
                                changed = true;
                            }

                            if (!user.authProvider || user.authProvider === "local") {
                                user.authProvider = "facebook";
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
    } else {
        console.warn("⚠️ Facebook OAuth env vars missing. Facebook login will not work.");
    }

    // ---------- APPLE ----------
    if (
        process.env.APPLE_CLIENT_ID &&
        process.env.APPLE_TEAM_ID &&
        process.env.APPLE_KEY_ID &&
        process.env.APPLE_PRIVATE_KEY &&
        process.env.APPLE_CALLBACK_URL
    ) {
        passport.use(
            new AppleStrategy(
                {
                    clientID: process.env.APPLE_CLIENT_ID,          // Services ID, e.g. com.konarcard.web
                    teamID: process.env.APPLE_TEAM_ID,              // 10-char Team ID from Apple dev portal
                    keyID: process.env.APPLE_KEY_ID,                // 10-char Key ID
                    // The private key is either a raw PEM string (newlines preserved) or a base64-encoded PEM.
                    privateKeyString: process.env.APPLE_PRIVATE_KEY.includes("BEGIN PRIVATE KEY")
                        ? process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, "\n")
                        : Buffer.from(process.env.APPLE_PRIVATE_KEY, "base64").toString("utf8"),
                    callbackURL: process.env.APPLE_CALLBACK_URL,
                    scope: ["name", "email"],
                    passReqToCallback: true,
                },
                async (req, accessToken, refreshToken, idToken, profile, done) => {
                    try {
                        // passport-apple puts the decoded idToken payload on profile by default.
                        // Fields: sub (apple user id), email, email_verified
                        const applePayload = profile || {};
                        const appleId = applePayload.sub || applePayload.id || null;
                        const email = (applePayload.email || "").toLowerCase() || null;

                        // Apple only sends `name` (JSON string in req.body.user) on the VERY FIRST sign-in.
                        // After that, we have to rely on what we stored before, or fall back to the email.
                        let name = "";
                        try {
                            if (req.body && req.body.user) {
                                const parsed = JSON.parse(req.body.user);
                                const first = parsed?.name?.firstName || "";
                                const last = parsed?.name?.lastName || "";
                                name = `${first} ${last}`.trim();
                            }
                        } catch (_) {
                            // ignore parse errors — name stays ""
                        }

                        if (!appleId) {
                            return done(null, false, { message: "Apple account missing user id." });
                        }

                        let user = await User.findOne({ appleId });
                        if (!user && email) user = await User.findOne({ email });

                        if (!user) {
                            if (!email) {
                                return done(null, false, {
                                    message:
                                        "Apple did not return an email address. Please sign in with Google or create an account with email.",
                                });
                            }

                            user = await User.create({
                                name: name || email.split("@")[0],
                                email,
                                password: undefined,
                                isVerified: true,
                                appleId,
                                authProvider: "apple",
                            });
                            fireWelcomeEmail(user);
                        } else {
                            let changed = false;

                            if (!user.appleId) {
                                user.appleId = appleId;
                                changed = true;
                            }

                            if (!user.isVerified) {
                                user.isVerified = true;
                                changed = true;
                            }

                            if (!user.authProvider || user.authProvider === "local") {
                                user.authProvider = "apple";
                                changed = true;
                            }

                            // Apple name is only provided on first ever sign-in.
                            // If we captured one this time and we don't have one stored, save it.
                            if (name && !user.name) {
                                user.name = name;
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
    } else {
        console.warn("⚠️ Apple OAuth env vars missing. Apple login will not work.");
    }
};