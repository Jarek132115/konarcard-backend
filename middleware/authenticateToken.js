const jwt = require('jsonwebtoken');
const User = require('../models/user');

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token == null) {
        return res.status(401).json({ error: 'Access Denied: No token provided' });
    }

    jwt.verify(token, process.env.JWT_SECRET, async (err, user) => {
        if (err) {
            console.error("JWT Verification Error:", err.message);
            return res.status(403).json({ error: 'Access Denied: Invalid or expired token' });
        }

        try {
            const fullUser = await User.findById(user.id);

            if (!fullUser) {
                return res.status(404).json({ error: 'User not found' });
            }

            const now = new Date();

            if (!fullUser.isSubscribed && fullUser.trialExpires < now) {
                return res.status(403).json({ error: 'Trial expired or no active subscription' });
            }

            req.user = fullUser;
            next();
        } catch (dbError) {
            console.error("Database error in authenticateToken:", dbError.message);
            return res.status(500).json({ error: 'Internal server error' });
        }
    });
};

module.exports = authenticateToken;