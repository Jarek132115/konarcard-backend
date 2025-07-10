// backend/routes/stripe.js
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

// IMPORTANT: This raw body parser is only for webhooks.
// Other routes will need express.json() or express.urlencoded()
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    // ADDED LOG: Detailed event info
    console.log(`Backend: Webhook event constructed successfully. Type: ${event.type} ID: ${event.id} Livemode: ${event.livemode}`);
  } catch (err) {
    console.error('⚠️ Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      // ADDED LOG: Session details
      console.log(`Backend: Webhook Event - checkout.session.completed for session ${session.id}. Customer: ${session.customer}. Subscription: ${session.subscription}. Mode: ${session.mode}`);

      try { // ADDED TRY-CATCH BLOCK FOR INTERNAL PROCESSING
        const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
          expand: ['line_items', 'customer'],
        });
        const customerEmail = fullSession.customer_details?.email || fullSession.customer?.email;
        const amountTotal = (fullSession.amount_total / 100).toFixed(2);

        // ADDED LOG: More session details
        console.log(`Backend: checkout.session.completed - Retrieved full session. Customer Email: ${customerEmail}. Amount: ${amountTotal}.`);

        // Find user by customer ID or email
        let user = null;
        if (fullSession.customer && fullSession.customer.id) {
          user = await User.findOne({ stripeCustomerId: fullSession.customer.id });
          // ADDED LOG: User find attempt 1
          console.log(`Backend: checkout.session.completed - Attempted to find user by stripeCustomerId: ${fullSession.customer.id}. User found (by customerId): ${!!user}`);
          if (!user && customerEmail) {
            user = await User.findOne({ email: customerEmail });
            // ADDED LOG: User find attempt 2
            console.log(`Backend: checkout.session.completed - User not found by customer ID, attempting by email: ${customerEmail}. User found (by email): ${!!user}`);
            if (user) {
              user.stripeCustomerId = fullSession.customer.id;
              await user.save(); // IMPORTANT SAVE AFTER ADDING CUSTOMER ID
              console.log(`Backend: checkout.session.completed - User found by email, updated with stripeCustomerId: ${fullSession.customer.id} and saved.`);
            }
          }
        } else if (customerEmail) {
          user = await User.findOne({ email: customerEmail });
          // ADDED LOG: User find attempt (only email)
          console.log(`Backend: checkout.session.completed - Only customer email available: ${customerEmail}. User found (by email only): ${!!user}`);
        }

        if (!user) {
          console.warn(`Backend: checkout.session.completed - No user found in DB for Stripe customer ID ${fullSession.customer?.id} or email ${customerEmail}. Cannot update subscription status.`);
          // Even if user not found, return 200 OK to Stripe to avoid retries
          return res.status(200).send('User not found for webhook event.');
        }

        if (session.mode === 'subscription') {
          console.log("Backend: Processing subscription checkout completion.");
          const subscriptionId = fullSession.subscription;

          // Ensure user is found before attempting to update (redundant check, but harmless)
          if (user) {
            user.isSubscribed = true;
            user.stripeSubscriptionId = subscriptionId;
            try { // ADDED TRY-CATCH FOR USER.SAVE
              await user.save(); // <-- THIS IS THE CRUCIAL SAVE OPERATION
              console.log(`Backend: User ${user._id} marked as subscribed via checkout.session.completed. isSubscribed: ${user.isSubscribed}, stripeSubscriptionId: ${user.stripeSubscriptionId}`);
            } catch (saveErr) {
              console.error(`Backend: ERROR saving user after checkout.session.completed:`, saveErr);
              // Log the error but still return 200 OK to Stripe
              return res.status(200).send('Internal user save error for webhook event.');
            }
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
      } catch (internalErr) { // CATCH FOR THE MAIN TRY-CATCH BLOCK
        console.error(`Backend: Major ERROR processing checkout.session.completed webhook internally:`, internalErr);
        return res.status(200).send('Major internal webhook error processed.'); // Still 200 to Stripe
      }
      break;
    }

    case 'customer.subscription.created': {
      const subscription = event.data.object;
      console.log(`Backend: Webhook Event - customer.subscription.created for subscription ${subscription.id}. Customer ID: ${subscription.customer}`);
      const customerId = subscription.customer;

      try { // ADDED TRY-CATCH FOR INTERNAL PROCESSING
        const user = await User.findOne({ stripeCustomerId: customerId });
        console.log(`Backend: customer.subscription.created - User found by stripeCustomerId: ${!!user}`);
        if (user) {
          user.isSubscribed = true;
          user.stripeSubscriptionId = subscription.id;
          try { // ADDED TRY-CATCH FOR USER.SAVE
            await user.save();
            console.log(`Backend: User ${user._id} status updated to subscribed (created event). isSubscribed: ${user.isSubscribed}, stripeSubscriptionId: ${user.stripeSubscriptionId}`);
          } catch (saveErr) {
            console.error(`Backend: ERROR saving user after customer.subscription.created:`, saveErr);
            return res.status(200).send('Internal user save error for created webhook.');
          }

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
      } catch (internalErr) {
        console.error(`Backend: Major ERROR processing customer.subscription.created webhook internally:`, internalErr);
        return res.status(200).send('Major internal webhook error processed.');
      }
      break;
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      console.log(`Backend: Webhook Event - customer.subscription.updated for subscription ${subscription.id} to status ${subscription.status}`);
      const customerId = subscription.customer;

      try { // ADDED TRY-CATCH FOR INTERNAL PROCESSING
        const user = await User.findOne({ stripeCustomerId: customerId });
        console.log(`Backend: customer.subscription.updated - User found by stripeCustomerId: ${!!user}`);
        if (user) {
          const isActive = ['active', 'trialing', 'past_due', 'unpaid'].includes(subscription.status);
          if (user.isSubscribed !== isActive) { // Only save if status changed
            user.isSubscribed = isActive;
            user.stripeSubscriptionId = subscription.id; // Ensure ID is updated
            try { // ADDED TRY-CATCH FOR USER.SAVE
              await user.save();
              console.log(`Backend: User ${user._id} status updated to isSubscribed: ${isActive} (updated event).`);
            } catch (saveErr) {
              console.error(`Backend: ERROR saving user after customer.subscription.updated:`, saveErr);
              return res.status(200).send('Internal user save error for updated webhook.');
            }
          } else {
            console.log(`Backend: User ${user._id} isSubscribed status already up-to-date (${isActive}). No DB change needed.`);
          }
        } else {
          console.warn(`Backend: User not found for stripeCustomerId ${customerId} on customer.subscription.updated event.`);
        }
      } catch (internalErr) {
        console.error(`Backend: Major ERROR processing customer.subscription.updated webhook internally:`, internalErr);
        return res.status(200).send('Major internal webhook error processed.');
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      console.log(`Backend: Webhook Event - customer.subscription.deleted for subscription ${subscription.id}`);
      const customerId = subscription.customer;

      try { // ADDED TRY-CATCH FOR INTERNAL PROCESSING
        const user = await User.findOne({ stripeCustomerId: customerId });
        console.log(`Backend: customer.subscription.deleted - User found by stripeCustomerId: ${!!user}`);
        if (user) {
          user.isSubscribed = false;
          user.stripeSubscriptionId = undefined;
          try { // ADDED TRY-CATCH FOR USER.SAVE
            await user.save();
            console.log(`Backend: User ${user._id} status updated to isSubscribed: false (deleted event).`);
          } catch (saveErr) {
            console.error(`Backend: ERROR saving user after customer.subscription.deleted:`, saveErr);
            return res.status(200).send('Internal user save error for deleted webhook.');
          }

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
      } catch (internalErr) {
        console.error(`Backend: Major ERROR processing customer.subscription.deleted webhook internally:`, internalErr);
        return res.status(200).send('Major internal webhook error processed.');
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

  res.status(200).send('OK'); // Always send 200 OK to Stripe to prevent retries
  console.log("Backend: Webhook processing finished, sending 200 OK.");
});

// NEW: Endpoint for frontend to confirm subscription session
router.post('/confirm-subscription', async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID is required.' });
  }

  try {
    console.log(`Backend: /confirm-subscription - Received request for sessionId: ${sessionId}`);
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    console.log(`Backend: /confirm-subscription - Retrieved Stripe session. Payment Status: ${session.payment_status}, Mode: ${session.mode}, Customer: ${session.customer}, Subscription: ${session.subscription}`);


    if (session.payment_status === 'paid' && session.mode === 'subscription' && session.customer && session.subscription) {
      let user = await User.findOne({ stripeCustomerId: session.customer });
      console.log(`Backend: /confirm-subscription - Attempted to find user by stripeCustomerId: ${session.customer}. User found: ${!!user}`);

      if (!user && session.customer_details?.email) {
        user = await User.findOne({ email: session.customer_details.email });
        console.log(`Backend: /confirm-subscription - User not found by customer ID, attempting by email: ${session.customer_details.email}. User found: ${!!user}`);
        if (user) {
          user.stripeCustomerId = session.customer;
          try { // ADDED TRY-CATCH FOR USER.SAVE
            await user.save();
            console.log(`Backend: /confirm-subscription - User found by email, updated with stripeCustomerId and saved.`);
          } catch (saveErr) {
            console.error(`Backend: /confirm-subscription - ERROR saving user with customerId after finding by email:`, saveErr);
            // Don't fail the request just for this, but log it.
          }
        }
      }

      if (user) {
        // Ensure the user's subscription status is updated in DB
        user.isSubscribed = true;
        user.stripeSubscriptionId = session.subscription;
        try { // ADDED TRY-CATCH FOR USER.SAVE
          await user.save();
          console.log(`Backend: /confirm-subscription - User ${user._id} marked as subscribed via direct confirmation. isSubscribed: ${user.isSubscribed}, stripeSubscriptionId: ${user.stripeSubscriptionId}`);
          return res.status(200).json({ success: true, message: 'Subscription confirmed.' });
        } catch (saveErr) {
          console.error(`Backend: /confirm-subscription - ERROR saving user after setting isSubscribed:`, saveErr);
          return res.status(500).json({ error: 'Failed to save subscription status.', details: saveErr.message });
        }
      } else {
        console.warn(`Backend: /confirm-subscription - User not found in DB for Stripe session customer ${session.customer} or email ${session.customer_details?.email}.`);
        return res.status(404).json({ error: 'User not found for this session.' });
      }
    } else {
      console.warn(`Backend: /confirm-subscription - Session ${sessionId} is not a valid paid subscription session. Details: Payment Status=${session.payment_status}, Mode=${session.mode}`);
      return res.status(400).json({ error: 'Invalid or unpaid subscription session.' });
    }

  } catch (error) {
    console.error('Backend: Error confirming subscription session in catch block:', error);
    res.status(500).json({ error: 'Failed to confirm subscription session.', details: error.message });
  }
});


module.exports = router;