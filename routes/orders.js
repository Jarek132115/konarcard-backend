const express = require('express');
const router = express.Router();
const { listOrders } = require('../controllers/ordersController');

/**
 * Middleware: requires authentication (req.user.id must be set by JWT middleware).
 */
function requireAuth(req, res, next) {
    if (req.user?.id) return next();
    return res.status(401).json({ error: 'Unauthorized' });
}

/**
 * GET /me/orders
 * Returns the authenticated user's orders (cards + subscriptions).
 */
router.get('/me/orders', requireAuth, listOrders);

module.exports = router;
