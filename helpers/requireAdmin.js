const User = require("../models/user");

const ADMIN_EMAILS = new Set([
    "supportteam@konarcard.com",
]);

function cleanEmail(value) {
    return String(value || "").trim().toLowerCase();
}

module.exports = async function requireAdmin(req, res, next) {
    try {
        const reqUser = req.user || null;

        if (!reqUser) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const directEmail = cleanEmail(reqUser.email);
        const directRole = String(reqUser.role || "").trim().toLowerCase();

        if (directRole === "admin" || ADMIN_EMAILS.has(directEmail)) {
            req.adminUser = reqUser;
            return next();
        }

        const userId = reqUser._id || reqUser.id;
        if (!userId) {
            return res.status(403).json({ error: "Admin access required" });
        }

        const freshUser = await User.findById(userId)
            .select("_id name email role")
            .lean();

        if (!freshUser) {
            return res.status(403).json({ error: "Admin access required" });
        }

        const freshEmail = cleanEmail(freshUser.email);
        const freshRole = String(freshUser.role || "").trim().toLowerCase();

        if (freshRole === "admin" || ADMIN_EMAILS.has(freshEmail)) {
            req.adminUser = freshUser;
            return next();
        }

        return res.status(403).json({ error: "Admin access required" });
    } catch (err) {
        console.error("requireAdmin error:", err);
        return res.status(500).json({ error: "Failed to verify admin access" });
    }
};