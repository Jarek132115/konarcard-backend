// routes/stripe.js
const express = require('express');
const router = express.Router();
const { handleStripeWebhook } = require('../controllers/webhookController');

// IMPORTANT: raw body for Stripe signature verification
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  handleStripeWebhook
);

module.exports = router;
