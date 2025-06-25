const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const sendEmail = require('../utils/SendEmail');
const {
  orderConfirmationTemplate,
} = require('../utils/emailTemplates'); // <<<--- THIS IS THE CRUCIAL FIX FOR THE PATH

// DEBUG LOG: Confirming stripe.js route file is being loaded
console.log("Backend: routes/stripe.js file loaded.");


router.post('/', express.raw({ type: 'application/json' }), async (req, res) => { // <<<--- THIS IS THE CRUCIAL FIX FOR THE ROUTER PATH
  // DEBUG LOG: Confirming /stripe POST request received
  console.log("Backend: Received POST request to /stripe webhook.");

  const sig = req.headers['stripe-signature'];

  let event;
  try {
    // Ensure endpointSecret is directly used here
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log("Backend: Webhook event constructed successfully.");
  } catch (err) {
    console.error('⚠️ Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    console.log("Backend: Webhook event type is checkout.session.completed. Processing order.");
    const session = event.data.object;
    const customerEmail = session.customer_details?.email;
    const amountPaid = (session.amount_total / 100).toFixed(2);

    // Email you (admin) about the new order
    try {
      await sendEmail({
        email: process.env.EMAIL_USER,
        subject: `New Konar Card Order - £${amountPaid}`,
        message: `<p>New order from: ${customerEmail}</p><p>Total: £${amountPaid}</p>`
      });
      console.log(`Backend: Admin email sent to ${process.env.EMAIL_USER}`);
    } catch (emailErr) {
      console.error("Backend: Error sending admin email:", emailErr);
    }

    // Email customer with order confirmation
    if (customerEmail) {
      try {
        await sendEmail({
          email: customerEmail,
          subject: 'Your Konar Card Order Confirmation',
          message: orderConfirmationTemplate(customerEmail, amountPaid)
        });
        console.log(`Backend: Customer email sent to ${customerEmail}`);
      } catch (emailErr) {
        console.error("Backend: Error sending customer email:", emailErr);
      }
    }
  } else {
    console.log(`Backend: Received webhook event type: ${event.type}. Not processing as checkout.session.completed.`);
  }

  res.status(200).send('OK');
  console.log("Backend: Webhook processing finished, sending 200 OK.");
});

module.exports = router;