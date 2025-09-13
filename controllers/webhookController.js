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
            case 'checkout.session.completed': {
                const session = event.data.object;

                console.log(
                    `checkout.session.completed: id=${session.id} mode=${session.mode} cust=${session.customer} sub=${session.subscription}`
                );

                // Try to resolve user
                let userId = session?.metadata?.userId || null;
                if (!userId && session.customer) {
                    const u = await User.findOne({ stripeCustomerId: session.customer }).select('_id');
                    if (u) userId = u._id.toString();
                }

                if (!userId) {
                    console.warn(`No userId found for session ${session.id}`);
                }

                if (session.mode === 'payment') {
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
                }

                if (session.mode === 'subscription') {
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
                }
                break;
            }

            case 'customer.subscription.created': {
                const subscription = event.data.object;
                const customerId = subscription.customer;
                const status = subscription.status;
                const isActive = ['active', 'trialing', 'past_due', 'unpaid'].includes(status);

                const user = await User.findOne({ stripeCustomerId: customerId });
                if (user) {
                    user.isSubscribed = isActive;
                    user.stripeSubscriptionId = subscription.id;
                    user.trialExpires = undefined;
                    user.trialEmailRemindersSent = [];
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
                break;
            }

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
                            status: 'active',
                        }
                    );
                }
                break;
            }

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
        // Always ack to prevent endless Stripe retries
        res.status(200).send('OK');
    }
};
