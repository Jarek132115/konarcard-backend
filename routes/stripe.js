const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const sendEmail = require('../utils/SendEmail');
const {
  orderConfirmationTemplate,
  subscriptionConfirmationTemplate,
} = require('../utils/emailTemplates'); 
const User = require('../models/user'); 

router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
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

      const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ['line_items', 'customer'],
      });
      const lineItems = fullSession.line_items.data;
      const customerEmail = fullSession.customer_details?.email || fullSession.customer?.email; 
      const amountTotal = (fullSession.amount_total / 100).toFixed(2);

      // Find user by customer ID or email
      let user = null;
      if (fullSession.customer && fullSession.customer.id) {
        user = await User.findOne({ stripeCustomerId: fullSession.customer.id });
        if (!user) {
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

      if (session.mode === 'payment') {
        console.log("Backend: Processing one-time payment."); 
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
        console.log("Backend: Processing subscription checkout completion.");
        const subscriptionId = fullSession.subscription; 

        if (user) {
          user.isSubscribed = true; 
          user.stripeSubscriptionId = subscriptionId;
          await user.save();
          console.log(`Backend: User ${user._id} marked as subscribed via checkout.session.completed.`);
        }

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
      const subscription = event.data.object; 
      console.log(`Backend: Webhook Event - customer.subscription.created for subscription ${subscription.id}`);
      const customerId = subscription.customer; 

      const user = await User.findOne({ stripeCustomerId: customerId });
      if (user) {
        user.isSubscribed = true;
        user.stripeSubscriptionId = subscription.id;
        await user.save();
        console.log(`Backend: User ${user._id} status updated to subscribed (created event).`);

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
        const isActive = ['active', 'trialing', 'past_due', 'unpaid'].includes(subscription.status); 
        user.isSubscribed = isActive;
        user.stripeSubscriptionId = subscription.id; 
        await user.save();
        console.log(`Backend: User ${user._id} status updated to isSubscribed: ${isActive} (updated event).`);
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
        user.stripeSubscriptionId = undefined; 
        await user.save();
        console.log(`Backend: User ${user._id} status updated to isSubscribed: false (deleted event).`);

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
      if (invoice.customer_email) {
        console.log(`Backend: Payment succeeded for ${invoice.customer_email}. Amount: ${(invoice.amount_paid / 100).toFixed(2)}`);
      }
      break;
    }

    default:
      console.log(`Backend: Unhandled event type ${event.type}`);
  }

  res.status(200).send('OK');
  console.log("Backend: Webhook processing finished, sending 200 OK.");
});

module.exports = router;