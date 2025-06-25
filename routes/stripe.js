const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const sendEmail = require('../utils/SendEmail');
const {
  orderConfirmationTemplate,
} = require('../utils/emailTemplates');

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('⚠️ Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const customerEmail = session.customer_details?.email;
    const amountPaid = (session.amount_total / 100).toFixed(2);

    // Email you
    await sendEmail(
      process.env.EMAIL_USER,
      `New Konar Card Order - £${amountPaid}`,
      `<p>New order from: ${customerEmail}</p><p>Total: £${amountPaid}</p>`
    );

    // Email customer
    if (customerEmail) {
      await sendEmail(
        customerEmail,
        'Your Konar Card Order Confirmation',
        orderConfirmationTemplate(customerEmail, amountPaid)
      );
    }
  }

  res.status(200).send('OK');
});

module.exports = router;
