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
const Order = require('../models/Order');

// Helpers
const toInt = (v, d = 0) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
};
const clean = (obj) =>
    Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== undefined && v !== null));

async function upsertOrderBy(where, updates) {
    return Order.findOneAndUpdate(
        where,
        { $set: clean(updates) },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
}

// Map Stripe subscription.status to our boolean
function computeIsSubscribed(status) {
    // Treat these as "subscribed" for app access; adjust if your business rules differ
    return ['active', 'trialing', 'past_due', 'unpaid'].includes(status);
}

// Mirror Stripe trial to our user model
function applyTrialMirror(user, subscription) {
    const status = subscription.status;
    if (status === 'trialing') {
        const trialEndSec = subscription.trial_end; // UNIX seconds
        user.trialExpires = trialEndSec ? new Date(trialEndSec * 1000) : undefined;
    } else {
        // Not trialing anymore -> clear any stored trial
        user.trialExpires = undefined;
    }
}

exports.handleStripeWebhook = async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
        console.log(`Webhook OK: type=${event.type} id=${event.id}`);
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
                const isSub = session.mode === 'subscription';
                const isCard = session.mode === 'payment';

                console.log(
                    `checkout.session.completed: id=${session.id} mode=${session.mode} cust=${session.customer} sub=${session.subscription || 'n/a'}`
                );

                // Resolve user
                let userId = session?.metadata?.userId || null;
                if (!userId && session.customer) {
                    const u = await User.findOne({ stripeCustomerId: session.customer }).select('_id');
                    if (u) userId = u._id.toString();
                }
                if (!userId) console.warn(`No userId found for session ${session.id}`);

                if (isCard) {
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
                    console.log(`✅ Card order upserted by sessionId=${session.id}, user=${userId}`);
                }

                if (isSub) {
                    // Primary: upsert by subscription id (when present)
                    if (session.subscription) {
                        await upsertOrderBy(
                            { stripeSubscriptionId: session.subscription },
                            {
                                userId,
                                type: 'subscription',
                                stripeSessionId: session.id,
                                stripeSubscriptionId: session.subscription,
                                stripeCustomerId: session.customer || null,
                                status: 'pending',
                                amountTotal: session.amount_total ?? null,
                                currency: session.currency || 'gbp',
                                metadata: session.metadata || {},
                            }
                        );
                        console.log(`✅ Sub seed upserted by subscriptionId=${session.subscription}, user=${userId}`);
                    }

                    // Fallback: also update any pending order we created at checkout by sessionId
                    await upsertOrderBy(
                        { stripeSessionId: session.id },
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
                    console.log(`✅ Sub seed ensured by sessionId=${session.id}, user=${userId}`);
                }

                break;
            }

            // ------------------------------------------------------------
            // Subscription lifecycle
            // ------------------------------------------------------------
            case 'customer.subscription.created': {
                const subscription = event.data.object;
                const customerId = subscription.customer;
                const status = subscription.status;
                const isSubscribed = computeIsSubscribed(status);

                const user = await User.findOne({ stripeCustomerId: customerId });

                if (user) {
                    user.isSubscribed = isSubscribed;
                    user.stripeSubscriptionId = subscription.id;

                    // Mirror Stripe's trial to our DB (do NOT create new trials)
                    applyTrialMirror(user, subscription);

                    // Optional: only clear reminders on brand new creation
                    user.trialEmailRemindersSent = user.trialExpires ? user.trialEmailRemindersSent : [];
                    await user.save();
                }

                // Upsert by subscription id
                await upsertOrderBy(
                    { stripeSubscriptionId: subscription.id },
                    {
                        userId: user ? user._id : null,
                        type: 'subscription',
                        stripeSubscriptionId: subscription.id,
                        stripeCustomerId: customerId,
                        status: isSubscribed ? 'active' : 'pending',
                    }
                );

                // Also connect any session-seeded order missing the sub id
                await upsertOrderBy(
                    { stripeCustomerId: customerId, type: 'subscription', stripeSubscriptionId: null },
                    {
                        userId: user ? user._id : null,
                        stripeSubscriptionId: subscription.id,
                        status: isSubscribed ? 'active' : 'pending',
                    }
                );

                console.log(`subscription.created handled: sub=${subscription.id} status=${status}`);
                break;
            }

            case 'customer.subscription.updated': {
                const subscription = event.data.object;
                const customerId = subscription.customer;
                const status = subscription.status;
                const isSubscribed = computeIsSubscribed(status);

                const user = await User.findOne({ stripeCustomerId: customerId });
                if (user) {
                    user.isSubscribed = isSubscribed;
                    user.stripeSubscriptionId = subscription.id;

                    // Mirror Stripe's trial exactly
                    applyTrialMirror(user, subscription);

                    await user.save();
                }

                await upsertOrderBy(
                    { stripeSubscriptionId: subscription.id },
                    {
                        userId: user ? user._id : null,
                        type: 'subscription',
                        stripeSubscriptionId: subscription.id,
                        stripeCustomerId: customerId,
                        status: isSubscribed ? 'active' : 'pending',
                    }
                );

                console.log(`subscription.updated handled: sub=${subscription.id} status=${status}`);
                break;
            }

            case 'customer.subscription.deleted': {
                const subscription = event.data.object;
                const customerId = subscription.customer;

                const user = await User.findOne({ stripeCustomerId: customerId });
                if (user) {
                    user.isSubscribed = false;
                    user.stripeSubscriptionId = undefined;
                    user.trialExpires = undefined; // no trial after deletion
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
            // Invoices
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

        // Always acknowledge quickly so Stripe doesn't retry forever
        res.status(200).send('OK');
    } catch (err) {
        // Log error but still return 200 to prevent Stripe retries
        console.error('Webhook handler error (non-fatal):', err);
        res.status(200).send('OK');
    }
};
