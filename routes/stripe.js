// routes/stripe.js
const express = require('express');
const router = express.Router();

// Import matches actual file name: "webHookController.js" (capital H)
const { handleStripeWebhook } = require('../controllers/webHookController');

// Stripe requires raw body for signature verification
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  handleStripeWebhook
);

module.exports = router;
  