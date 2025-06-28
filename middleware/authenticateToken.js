    // New file: KONAR-NFC-LOCAL/backend/middleware/authenticateToken.js
    const jwt = require('jsonwebtoken');

    const authenticateToken = (req, res, next) => {
        // Extract token from Authorization header
        const authHeader = req.headers['authorization'];
        // The header typically looks like "Bearer YOUR_TOKEN_HERE"
        const token = authHeader && authHeader.split(' ')[1];

        if (token == null) {
            // No token provided, meaning user is not authenticated
            return res.status(401).json({ error: 'Access Denied: No token provided' });
        }

        jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
            if (err) {
                // Token is invalid or expired
                console.error("JWT Verification Error:", err.message);
                return res.status(403).json({ error: 'Access Denied: Invalid or expired token' });
            }
            // If token is valid, attach user payload (id, email, name) to request object
            req.user = user;
            next(); // Proceed to the next middleware/route handler
        });
    };

    module.exports = authenticateToken;