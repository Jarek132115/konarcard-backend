const express = require('express');
const router = express.Router();
const { listOrders, getOrderById } = require('../controllers/ordersController');

// Simple auth gate
function requireAuth(req, res, next) {
    if (req.user?.id) return next();
    return res.status(401).json({ error: 'Unauthorized' });
}

// GET /me/orders
router.get('/me/orders', requireAuth, listOrders);

// GET /me/orders/:id
router.get('/me/orders/:id', requireAuth, getOrderById);

module.exports = router;
