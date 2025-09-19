// controllers/webHookController.js
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const sendEmail = require('../utils/SendEmail');
const { trialFinalWarningTemplate } = require('../utils/emailTemplates');

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

function computeIsSubscribed(status) {
    return ['active', 'trialing', 'past_due', 'unpaid'].includes(status);
}

function applyTrialMirror(user, subscription) {
    if (subscription.status === 'trialing') {
        const trialEndSec = subscription.trial_end;
        user.trialExpires = trialEndSec ? new Date(trialEndSec * 1000) : undefined;
    } else {
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

                    // 🔹 Calculate delivery window (today+1 → today+4)
                    const today = new Date();
                    const start = new Date(today);
                    start.setDate(today.getDate() + 1);
                    const end = new Date(today);
                    end.setDate(today.getDate() + 4);

                    const monthNames = [
                        'January', 'February', 'March', 'April', 'May', 'June',
                        'July', 'August', 'September', 'October', 'November', 'December'
                    ];
                    const shortMonth = (d) => monthNames[d.getMonth()].slice(0, 3);

                    let deliveryWindow;
                    const sameMonth =
                        start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
                    if (sameMonth) {
                        deliveryWindow = `${start.getDate()}–${end.getDate()} ${monthNames[start.getMonth()]}`;
                    } else if (start.getFullYear() === end.getFullYear()) {
                        deliveryWindow = `${start.getDate()} ${shortMonth(start)} – ${end.getDate()} ${shortMonth(end)}`;
                    } else {
                        deliveryWindow = `${start.getDate()} ${shortMonth(start)} ${start.getFullYear()} – ${end.getDate()} ${shortMonth(end)} ${end.getFullYear()}`;
                    }

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
                            deliveryWindow,
                            metadata: session.metadata || {},
                        }
                    );
                    console.log(
                        `✅ Card order upserted with deliveryWindow="${deliveryWindow}", sessionId=${session.id}, user=${userId}`
                    );
                }

                if (isSub) {
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
                        console.log(
                            `✅ Sub seed upserted by subscriptionId=${session.subscription}, user=${userId}`
                        );
                    }

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

            case 'customer.subscription.created':
            case 'customer.subscription.updated': {
                const subscription = event.data.object;
                const customerId = subscription.customer;
                const status = subscription.status;
                const isSubscribed = computeIsSubscribed(status);

                const user = await User.findOne({ stripeCustomerId: customerId });
                if (user) {
                    user.isSubscribed = isSubscribed;
                    user.stripeSubscriptionId = subscription.id;
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
                        status: isSubscribed ? status : 'pending',
                        amountTotal: subscription.items?.data?.[0]?.price?.unit_amount || null,
                        currency: subscription.currency || 'gbp',
                        metadata: subscription.metadata || {},
                    }
                );

                console.log(`${event.type} handled: sub=${subscription.id} status=${status}`);
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
        res.status(200).send('OK');
    }
};
