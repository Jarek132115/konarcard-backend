// controllers/webHookController.js
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
const Order = require('../models/Order'); // <-- IMPORTANT: capital "O"

// Helper: safe int
const toInt = (v, d = 0) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
};

// Helper: strip undefined/null
const clean = (obj) =>
    Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== undefined && v !== null));

// Helper: upsert an order by a unique key
async function upsertOrderBy(where, updates) {
    return Order.findOneAndUpdate(
        where,
        { $set: clean(updates) },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
}

exports.handleStripeWebhook = async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        // req.body is a Buffer because express.raw is used in the route
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
        console.log(
            `Webhook OK: type=${event.type} id=${event.id} live=${event.livemode}`
        );
    } catch (err) {
        console.error('⚠️ Stripe webhook signature error:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        switch (event.type) {
            // ------------------------------------------------------------
            // Checkout finished (card payment or subscription start)
            // ------------------------------------------------------------
            case 'checkout.session.completed': {
                const session = event.data.object;
                // session.mode: "payment" | "subscription"
                // session.customer: customer id
                // session.subscription: subscription id (if mode === 'subscription')
                // session.amount_total / session.currency
                // session.metadata: we set kind/userId/quantity in checkout

                console.log(
                    `checkout.session.completed: id=${session.id} mode=${session.mode} cust=${session.customer} sub=${session.subscription}`
                );

                // Resolve user
                let userId = session?.metadata?.userId || null;
                if (!userId && session.customer) {
                    const u = await User.findOne({ stripeCustomerId: session.customer }).select('_id');
                    if (u) userId = u._id.toString();
                }
                if (!userId) {
                    console.warn(`No userId found for session ${session.id}`);
                }

                if (session.mode === 'payment') {
                    // One-time Konar Card order
                    const quantity = toInt(session?.metadata?.quantity, 1);

                    await upsertOrderBy(
                        { stripeSessionId: session.id },
                        {
                            userId,
                            type: 'card',
                            stripeSessionId: session.id,
                            stripeCustomerId: session.customer || null,
                            quantity,
                            amountTotal: session.amount_total ?? null,
                            currency: session.currency || 'gbp',
                            status: session.payment_status === 'paid' ? 'paid' : 'pending',
                            metadata: session.metadata || {},
                        }
                    );

                    console.log(`Order (card) upserted for session ${session.id} user=${userId}`);
                }

                if (session.mode === 'subscription') {
                    // Create/seed a subscription "order" record (status will be refined by sub events)
                    await upsertOrderBy(
                        { stripeSubscriptionId: session.subscription },
                        {
                            userId,
                            type: 'subscription',
                            stripeSessionId: session.id,
                            stripeSubscriptionId: session.subscription || null,
                            stripeCustomerId: session.customer || null,
                            status: 'pending',
                            amountTotal: session.amount_total ?? null,
                            currency: session.currency || 'gbp',
                            metadata: session.metadata || {},
                        }
                    );

                    console.log(`Order (subscription seed) upserted for sub ${session.subscription} user=${userId}`);
                }

                break;
            }

            // ------------------------------------------------------------
            // Subscription lifecycle
            // ------------------------------------------------------------
            case 'customer.subscription.created': {
                const subscription = event.data.object;
                const customerId = subscription.customer;
                const status = subscription.status; // trialing/active/incomplete/...
                const isActive = ['active', 'trialing', 'past_due', 'unpaid'].includes(status);

                // Update user flags
                const user = await User.findOne({ stripeCustomerId: customerId });
                if (user) {
                    user.isSubscribed = isActive;
                    user.stripeSubscriptionId = subscription.id;
                    user.trialExpires = undefined;
                    user.trialEmailRemindersSent = [];
                    await user.save();
                }

                // Update/create order record for subscription
                await upsertOrderBy(
                    { stripeSubscriptionId: subscription.id },
                    {
                        userId: user ? user._id : null,
                        type: 'subscription',
                        stripeSubscriptionId: subscription.id,
                        stripeCustomerId: customerId,
                        status: isActive ? 'active' : 'pending',
                    }
                );

                console.log(`subscription.created handled: sub=${subscription.id} active=${isActive}`);
                break;
            }

            case 'customer.subscription.updated': {
                const subscription = event.data.object;
                const customerId = subscription.customer;
                const status = subscription.status;
                const isActive = ['active', 'trialing', 'past_due', 'unpaid'].includes(status);

                const user = await User.findOne({ stripeCustomerId: customerId });
                if (user) {
                    user.isSubscribed = isActive;
                    user.stripeSubscriptionId = subscription.id;
                    if (isActive) user.trialExpires = undefined;
                    await user.save();
                }

                await upsertOrderBy(
                    { stripeSubscriptionId: subscription.id },
                    {
                        userId: user ? user._id : null,
                        type: 'subscription',
                        stripeSubscriptionId: subscription.id,
                        stripeCustomerId: customerId,
                        status: isActive ? 'active' : 'pending',
                    }
                );

                console.log(`subscription.updated handled: sub=${subscription.id} active=${isActive}`);
                break;
            }

            case 'customer.subscription.deleted': {
                const subscription = event.data.object;
                const customerId = subscription.customer;

                const user = await User.findOne({ stripeCustomerId: customerId });
                if (user) {
                    user.isSubscribed = false;
                    user.stripeSubscriptionId = undefined;
                    user.trialExpires = undefined;
                    user.trialEmailRemindersSent = [];
                    await user.save();
                }

                await upsertOrderBy(
                    { stripeSubscriptionId: subscription.id },
                    {
                        type: 'subscription',
                        stripeSubscriptionId: subscription.id,
                        stripeCustomerId: customerId,
                        status: 'canceled',
                    }
                );

                console.log(`subscription.deleted handled: sub=${subscription.id}`);
                break;
            }

            // ------------------------------------------------------------
            // Invoices (mark subscription orders paid/active)
            // ------------------------------------------------------------
            case 'invoice.payment_succeeded': {
                const invoice = event.data.object;
                console.log(
                    `invoice.payment_succeeded: invoice=${invoice.id} sub=${invoice.subscription} amount=${invoice.amount_paid}`
                );

                if (invoice.subscription) {
                    await upsertOrderBy(
                        { stripeSubscriptionId: invoice.subscription },
                        {
                            amountTotal: invoice.amount_paid ?? null,
                            currency: invoice.currency || 'gbp',
                            status: 'active', // treat as active
                        }
                    );
                }
                break;
            }

            // ------------------------------------------------------------
            // Trial reminder (email only)
            // ------------------------------------------------------------
            case 'customer.subscription.trial_will_end': {
                const subscription = event.data.object;
                const customerId = subscription.customer;

                const user = await User.findOne({ stripeCustomerId: customerId });
                if (user && subscription.status === 'trialing') {
                    await sendEmail({
                        email: user.email,
                        subject: 'Your Free Trial is Ending Soon!',
                        message: trialFinalWarningTemplate(user.name),
                    });
                    console.log(`Sent final trial warning to ${user.email}`);
                }
                break;
            }

            default:
                console.log(`Unhandled event: ${event.type}`);
        }

        res.status(200).send('OK');
    } catch (err) {
        console.error('Webhook handler error (non-fatal):', err);
        // Always ack to prevent endless Stripe retries after a valid signature
        res.status(200).send('OK');
    }
};
