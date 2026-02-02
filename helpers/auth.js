// backend/helpers/auth.js
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const User = require("../models/user");

const hashPassword = (password) => {
    return new Promise((resolve, reject) => {
        bcrypt.genSalt(12, (err, salt) => {
            if (err) return reject(err);
            bcrypt.hash(password, salt, (err2, hash) => {
                if (err2) return reject(err2);
                resolve(hash);
            });
        });
    });
};

const comparePassword = (password, hashed) => bcrypt.compare(password, hashed);

/**
 * ✅ Support BOTH:
 * - Authorization: Bearer <token>   (any casing)
 * - req.cookies.token
 */
const getTokenFromReq = (req) => {
    const header =
        req.headers?.authorization ||
        req.headers?.Authorization ||
        "";

    if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
        return header.slice(7).trim();
    }

    if (req.cookies?.token) return req.cookies.token;

    return null;
};

/**
 * ✅ requireAuth:
 * - verifies JWT
 * - checks user still exists
 * - attaches req.auth + req.user
 *
 * IMPORTANT:
 * - this middleware must ONLY authenticate (no plan/trial/verification gating here)
 */
const requireAuth = async (req, res, next) => {
    const token = getTokenFromReq(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const userId = decoded?.id || decoded?._id || decoded?.userId;
        if (!userId) return res.status(401).json({ error: "Invalid token" });

        // ✅ must still exist in DB (fixes deleted users / stale tokens)
        const user = await User.findById(userId).select("-password");
        if (!user) {
            try {
                res.clearCookie("token");
            } catch { }
            return res.status(404).json({ error: "User not found" });
        }

        req.auth = { id: user._id.toString(), email: user.email };
        req.user = user;
        return next();
    } catch (err) {
        try {
            res.clearCookie("token");
        } catch { }
        return res.status(401).json({ error: "Invalid token" });
    }
};

module.exports = {
    hashPassword,
    comparePassword,
    getTokenFromReq,
    requireAuth,
};
