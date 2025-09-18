const jwt = require('jsonwebtoken');

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access Denied: No token provided' });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
            console.error('JWT Verification Error:', err.message);
            // Use 401 so the frontend treats this like an auth-expired state
            return res.status(401).json({ error: 'Access Denied: Invalid or expired token' });
        }

        // Normalize user object: always expose .id
        req.user = {
            ...decoded,
            id: decoded.id || decoded._id || decoded.userId || null,
        };

        if (!req.user.id) {
            return res.status(401).json({ error: 'Access Denied: Invalid token payload' });
        }

        next();
    });
};

module.exports = authenticateToken;
