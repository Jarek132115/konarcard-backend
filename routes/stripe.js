// routes/stripe.js
const express = require('express');
const router = express.Router();

// ✅ Make sure the file name is exactly "webhookController.js" (lowercase "h")
const { handleStripeWebhook } = require('../controllers/webHookController');

// Stripe requires raw body for signature verification
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  handleStripeWebhook
);

module.exports = router;
