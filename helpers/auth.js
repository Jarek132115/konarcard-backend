const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

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
 * - Authorization: Bearer <token>  (frontend uses this)
 * - req.cookies.token              (your backend used this before)
 */
const getTokenFromReq = (req) => {
    const header = req.headers?.authorization || '';
    if (header.startsWith('Bearer ')) return header.slice(7).trim();
    if (req.cookies?.token) return req.cookies.token;
    return null;
};

const requireAuth = (req, res, next) => {
    const token = getTokenFromReq(req);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.auth = decoded;
        next();
    } catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
};

module.exports = {
    hashPassword,
    comparePassword,
    getTokenFromReq,
    requireAuth,
};
