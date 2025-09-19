// routes/orders.js
const express = require('express');
const router = express.Router();
const { listOrders } = require('../controllers/ordersController');

// Simple auth gate: requires req.user.id (your server sets req.user from JWT)
function requireAuth(req, res, next) {
    if (req.user?.id) return next();
    return res.status(401).json({ error: 'Unauthorized' });
}

// GET /me/orders
router.get('/me/orders', requireAuth, listOrders);

module.exports = router;
