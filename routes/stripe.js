const express = require('express');
const router = require('express').Router(); // Use router.Router() to avoid global state issues
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const sendEmail = require('../utils/SendEmail');
const {
  orderConfirmationTemplate,
  subscriptionConfirmationTemplate,
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

  // All user updates should happen here in the webhook to avoid race conditions.
  // The frontend will simply reload the user data after a successful redirect.

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      console.log(`Backend: Webhook Event - checkout.session.completed for session ${session.id}. Customer: ${session.customer}. Subscription: ${session.subscription}. Mode: ${session.mode}`);
      // We don't update user data here to prevent race conditions. The 'customer.subscription.created' event is more reliable.
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
          user.isSubscribed = true;
          user.stripeSubscriptionId = subscription.id;
          user.trialExpires = undefined; // <--- FIX: Explicitly clear trialExpires on subscription
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
          // Update status based on Stripe's current status
          user.isSubscribed = isActive;
          user.stripeSubscriptionId = subscription.id; 
          
          // FIX: If the subscription is active or trialing, but the trialExpires field is set, clear it out.
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
          user.trialExpires = undefined; // <--- FIX: Clear trialExpires on cancellation
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
    
    // NEW CASE: To handle trial ending notification
    case 'customer.subscription.trial_will_end': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        console.log(`Backend: Webhook Event - customer.subscription.trial_will_end for subscription ${subscription.id}`);

        const user = await User.findOne({ stripeCustomerId: customerId });
        if (user) {
            console.log(`Backend: Notifying user ${user._id} that trial will end soon.`);
            // TODO: Add your logic to send an email or in-app notification to the user here.
            // A good practice would be to send an email reminding them to subscribe.
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