const express = require('express');
const router = require('express').Router();
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const sendEmail = require('../utils/SendEmail');
const {
  orderConfirmationTemplate,
  subscriptionConfirmationTemplate,
  trialFirstReminderTemplate,
  trialFinalWarningTemplate,
} = require('../utils/emailTemplates');
const User = require('../models/user');

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log(`Backend: Webhook event constructed successfully. Type: ${event.type} ID: ${event.id} Livemode: ${event.livemode}`);
  } catch (err) {
    console.error('⚠️ Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      console.log(`Backend: Webhook Event - checkout.session.completed for session ${session.id}. Customer: ${session.customer}. Subscription: ${session.subscription}. Mode: ${session.mode}`);
      break;
    }

    case 'customer.subscription.created': {
      const subscription = event.data.object;
      console.log(`Backend: Webhook Event - customer.subscription.created for subscription ${subscription.id}. Customer ID: ${subscription.customer}`);
      const customerId = subscription.customer;

      try {
        const user = await User.findOne({ stripeCustomerId: customerId });
        console.log(`Backend: customer.subscription.created - User found by stripeCustomerId: ${!!user}`);
        if (user) {
          const isActive = ['active', 'trialing', 'past_due', 'unpaid'].includes(subscription.status);
          user.isSubscribed = isActive;
          user.stripeSubscriptionId = subscription.id;
          user.trialExpires = undefined;
          user.trialEmailRemindersSent = [];
          try {
            await user.save();
            console.log(`Backend: User ${user._id} status updated to subscribed (created event). isSubscribed: ${user.isSubscribed}, stripeSubscriptionId: ${user.stripeSubscriptionId}, trialExpires: ${user.trialExpires}`);
          } catch (saveErr) {
            console.error(`Backend: ERROR saving user after customer.subscription.created:`, saveErr);
          }
        } else {
          console.warn(`Backend: User not found for stripeCustomerId ${customerId} on customer.subscription.created event.`);
        }
      } catch (internalErr) {
        console.error(`Backend: Major ERROR processing customer.subscription.created webhook internally:`, internalErr);
      }
      break;
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      console.log(`Backend: Webhook Event - customer.subscription.updated for subscription ${subscription.id} to status ${subscription.status}`);
      const customerId = subscription.customer;

      try {
        const user = await User.findOne({ stripeCustomerId: customerId });
        if (user) {
          const isActive = ['active', 'trialing', 'past_due', 'unpaid'].includes(subscription.status);
          user.isSubscribed = isActive;
          user.stripeSubscriptionId = subscription.id;

          if (isActive) {
            user.trialExpires = undefined;
          }

          const isUserDirty = user.isModified('isSubscribed') || user.isModified('stripeSubscriptionId') || user.isModified('trialExpires');
          if (isUserDirty) {
            await user.save();
            console.log(`Backend: User ${user._id} status updated to isSubscribed: ${isActive} (updated event).`);
          } else {
            console.log(`Backend: User ${user._id} isSubscribed status already up-to-date (${isActive}). No DB change needed.`);
          }
        } else {
          console.warn(`Backend: User not found for stripeCustomerId ${customerId} on customer.subscription.updated event.`);
        }
      } catch (internalErr) {
        console.error(`Backend: Major ERROR processing customer.subscription.updated webhook internally:`, internalErr);
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      console.log(`Backend: Webhook Event - customer.subscription.deleted for subscription ${subscription.id}`);
      const customerId = subscription.customer;

      try {
        const user = await User.findOne({ stripeCustomerId: customerId });
        if (user) {
          user.isSubscribed = false;
          user.stripeSubscriptionId = undefined;
          user.trialExpires = undefined;
          user.trialEmailRemindersSent = [];
          await user.save();
          console.log(`Backend: User ${user._id} status updated to isSubscribed: false (deleted event).`);
          if (subscriptionConfirmationTemplate) {
            try {
              await sendEmail({
                email: user.email,
                subject: 'Your Konar Premium Subscription has been Cancelled',
                message: subscriptionConfirmationTemplate(user.name, null, 'subscription_cancelled')
              });
            } catch (emailErr) {
              console.error("Backend: Error sending cancellation email:", emailErr);
            }
          }
        } else {
          console.warn(`Backend: User not found for stripeCustomerId ${customerId} on customer.subscription.deleted event.`);
        }
      } catch (internalErr) {
        console.error(`Backend: Major ERROR processing customer.subscription.deleted webhook internally:`, internalErr);
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

    case 'customer.subscription.trial_will_end': {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      console.log(`Backend: Webhook Event - customer.subscription.trial_will_end for subscription ${subscription.id}`);

      try {
        const user = await User.findOne({ stripeCustomerId: customerId });
        // NEW LOGIC: Send the email if the user exists and is in a trialing state.
        if (user && subscription.status === 'trialing') {
          console.log(`Backend: Sending final trial warning email to user ${user._id}.`);
          await sendEmail({
            email: user.email,
            subject: 'Your Free Trial is Ending Soon!',
            message: trialFinalWarningTemplate(user.name),
          });
        } else {
          console.log(`Backend: Did not send final trial email. User not found or not in a trialing state.`);
        }
      } catch (err) {
        console.error(`Backend: Error processing 'customer.subscription.trial_will_end' event:`, err);
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