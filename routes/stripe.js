const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const sendEmail = require('../utils/SendEmail');
const {
  orderConfirmationTemplate,
  subscriptionConfirmationTemplate, // Assuming you will create this new template
} = require('../utils/emailTemplates'); // Path to emailTemplates fixed earlier
const User = require('../models/user'); // Import User model

// DEBUG LOG: Confirming stripe.js route file is being loaded
console.log("Backend: routes/stripe.js file loaded.");


router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  // DEBUG LOG: Confirming /stripe POST request received
  console.log("Backend: Received POST request to /stripe webhook.");

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log(`Backend: Webhook event constructed successfully. Type: ${event.type}`);
  } catch (err) {
    console.error('⚠️ Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      console.log(`Backend: Webhook Event - checkout.session.completed for session ${session.id}`);

      // Retrieve full session details to check line items for type (payment vs subscription)
      const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ['line_items', 'customer'],
      });
      const lineItems = fullSession.line_items.data;
      const customerEmail = fullSession.customer_details?.email || fullSession.customer?.email; // Use email from fullSession or customer object
      const amountTotal = (fullSession.amount_total / 100).toFixed(2);

      // Find user by customer ID or email
      let user = null;
      if (fullSession.customer && fullSession.customer.id) {
        user = await User.findOne({ stripeCustomerId: fullSession.customer.id });
        if (!user) {
          // If user not found by stripeCustomerId, try by email as fallback
          user = await User.findOne({ email: customerEmail });
          if (user) {
            user.stripeCustomerId = fullSession.customer.id;
            await user.save();
            console.log(`Backend: User found by email, updated with stripeCustomerId: ${fullSession.customer.id}`);
          }
        }
      } else if (customerEmail) {
        user = await User.findOne({ email: customerEmail });
      }

      // Check if it's a one-time payment or a subscription
      if (session.mode === 'payment') {
        console("Backend: Processing one-time payment.");
        // One-time product purchase logic (already existing)
        if (customerEmail) {
          try {
            await sendEmail({
              email: process.env.EMAIL_USER,
              subject: `New Konar Card Order - £${amountTotal}`,
              message: `<p>New order from: ${customerEmail}</p><p>Total: £${amountTotal}</p>`
            });
            await sendEmail({
              email: customerEmail,
              subject: 'Your Konar Card Order Confirmation',
              message: orderConfirmationTemplate(customerEmail, amountTotal)
            });
            console.log(`Backend: One-time payment emails sent for ${customerEmail}`);
          } catch (emailErr) {
            console.error("Backend: Error sending one-time payment emails:", emailErr);
          }
        }
      } else if (session.mode === 'subscription') {
        // For subscriptions, customer.subscription.created will also fire.
        // This block ensures immediate user update and email for subscription success if needed,
        // but customer.subscription.created is the canonical source of truth for status.
        console.log("Backend: Processing subscription checkout completion.");
        const subscriptionId = fullSession.subscription; // Get subscription ID from the session

        if (user) {
          user.isSubscribed = true; // Mark as subscribed immediately
          user.stripeSubscriptionId = subscriptionId; // Save subscription ID
          await user.save();
          console.log(`Backend: User ${user._id} marked as subscribed via checkout.session.completed.`);
        }

        // Send subscription confirmation email (can be redundant with customer.subscription.created, but good for immediacy)
        if (customerEmail && subscriptionConfirmationTemplate) {
          try {
            await sendEmail({
              email: customerEmail,
              subject: 'Welcome to Konar Premium!',
              message: subscriptionConfirmationTemplate(user?.name || customerEmail, amountTotal, 'subscription')
            });
            console.log(`Backend: Subscription welcome email sent to ${customerEmail}`);
          } catch (emailErr) {
            console.error("Backend: Error sending subscription welcome email:", emailErr);
          }
        }
      }
      break;
    }

    case 'customer.subscription.created': {
      const subscription = event.data.object; // contains subscription object
      console.log(`Backend: Webhook Event - customer.subscription.created for subscription ${subscription.id}`);
      const customerId = subscription.customer; // Stripe customer ID

      const user = await User.findOne({ stripeCustomerId: customerId });
      if (user) {
        user.isSubscribed = true;
        user.stripeSubscriptionId = subscription.id;
        await user.save();
        console.log(`Backend: User ${user._id} status updated to subscribed (created event).`);

        // Send a welcome email for new subscriptions/trials
        if (subscriptionConfirmationTemplate) {
          try {
            await sendEmail({
              email: user.email,
              subject: 'Your Konar Premium Subscription has Started!',
              message: subscriptionConfirmationTemplate(user.name, (subscription.items.data[0].price.unit_amount / 100).toFixed(2), 'subscription_started')
            });
            console.log(`Backend: Subscription started email sent to ${user.email}`);
          } catch (emailErr) {
            console.error("Backend: Error sending subscription started email:", emailErr);
          }
        }
      } else {
        console.warn(`Backend: User not found for stripeCustomerId ${customerId} on customer.subscription.created event.`);
      }
      break;
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      console.log(`Backend: Webhook Event - customer.subscription.updated for subscription ${subscription.id} to status ${subscription.status}`);
      const customerId = subscription.customer;

      const user = await User.findOne({ stripeCustomerId: customerId });
      if (user) {
        const isActive = ['active', 'trialing', 'past_due', 'unpaid'].includes(subscription.status); // Keep subscribed if past_due/unpaid for a grace period
        user.isSubscribed = isActive;
        user.stripeSubscriptionId = subscription.id; // Update in case it changed (e.g., migration)
        await user.save();
        console.log(`Backend: User ${user._id} status updated to isSubscribed: ${isActive} (updated event).`);

        // Additional email logic (e.g., payment failed, trial ending, plan changed) can go here
      } else {
        console.warn(`Backend: User not found for stripeCustomerId ${customerId} on customer.subscription.updated event.`);
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      console.log(`Backend: Webhook Event - customer.subscription.deleted for subscription ${subscription.id}`);
      const customerId = subscription.customer;

      const user = await User.findOne({ stripeCustomerId: customerId });
      if (user) {
        user.isSubscribed = false;
        user.stripeSubscriptionId = undefined; // Clear subscription ID
        await user.save();
        console.log(`Backend: User ${user._id} status updated to isSubscribed: false (deleted event).`);

        // Send a cancellation confirmation email
        if (subscriptionConfirmationTemplate) {
          try {
            await sendEmail({
              email: user.email,
              subject: 'Your Konar Premium Subscription has been Cancelled',
              message: subscriptionConfirmationTemplate(user.name, null, 'subscription_cancelled')
            });
            console.log(`Backend: Subscription cancelled email sent to ${user.email}`);
          } catch (emailErr) {
            console.error("Backend: Error sending cancellation email:", emailErr);
          }
        }
      } else {
        console.warn(`Backend: User not found for stripeCustomerId ${customerId} on customer.subscription.deleted event.`);
      }
      break;
    }

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object;
      console.log(`Backend: Webhook Event - invoice.payment_succeeded for invoice ${invoice.id}`);
      // This event fires for successful recurring payments or after trial conversion.
      // Use this if you want to send receipts for recurring payments beyond the initial confirmation.
      // The `customer.subscription.updated` event will also fire, potentially marking the sub as 'active' from 'trialing'.
      if (invoice.customer_email) {
        console.log(`Backend: Payment succeeded for ${invoice.customer_email}. Amount: ${(invoice.amount_paid / 100).toFixed(2)}`);
        // You could send a receipt email here if needed, or rely on Stripe's own receipts.
      }
      break;
    }

    // Add other event types as needed
    default:
      console.log(`Backend: Unhandled event type ${event.type}`);
  }

  res.status(200).send('OK');
  console.log("Backend: Webhook processing finished, sending 200 OK.");
});

module.exports = router;