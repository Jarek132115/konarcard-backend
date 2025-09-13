// controllers/webhookController.js
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
// If/when you want to persist orders, import your model here:
// const Order = require('../models/Order');

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
            `Backend: Webhook constructed. Type: ${event.type} ID: ${event.id} Livemode: ${event.livemode}`
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
                    `Backend: checkout.session.completed for ${session.id} | customer ${session.customer} | subscription ${session.subscription} | mode ${session.mode}`
                );

                // Example: (optional) later we can persist an Order here based on session.mode

                break;
            }

            case 'customer.subscription.created': {
                const subscription = event.data.object;
                const customerId = subscription.customer;
                console.log(
                    `Backend: customer.subscription.created ${subscription.id} for customer ${customerId}`
                );

                try {
                    const user = await User.findOne({ stripeCustomerId: customerId });
                    console.log(
                        `Backend: subscription.created -> user found? ${!!user}`
                    );

                    if (user) {
                        const isActive = ['active', 'trialing', 'past_due', 'unpaid'].includes(
                            subscription.status
                        );
                        user.isSubscribed = isActive;
                        user.stripeSubscriptionId = subscription.id;
                        user.trialExpires = undefined;
                        user.trialEmailRemindersSent = [];
                        await user.save();
                        console.log(
                            `Backend: user ${user._id} updated: isSubscribed=${isActive}, stripeSubscriptionId=${subscription.id}`
                        );
                    } else {
                        console.warn(
                            `Backend: No user found for stripeCustomerId ${customerId} (subscription.created)`
                        );
                    }
                } catch (saveErr) {
                    console.error(
                        'Backend: ERROR while processing customer.subscription.created:',
                        saveErr
                    );
                }
                break;
            }

            case 'customer.subscription.updated': {
                const subscription = event.data.object;
                const customerId = subscription.customer;
                console.log(
                    `Backend: customer.subscription.updated ${subscription.id} -> ${subscription.status}`
                );

                try {
                    const user = await User.findOne({ stripeCustomerId: customerId });
                    if (user) {
                        const isActive = ['active', 'trialing', 'past_due', 'unpaid'].includes(
                            subscription.status
                        );
                        user.isSubscribed = isActive;
                        user.stripeSubscriptionId = subscription.id;
                        if (isActive) user.trialExpires = undefined;

                        await user.save();
                        console.log(
                            `Backend: user ${user._id} updated: isSubscribed=${isActive}`
                        );
                    } else {
                        console.warn(
                            `Backend: No user found for stripeCustomerId ${customerId} (subscription.updated)`
                        );
                    }
                } catch (err) {
                    console.error(
                        'Backend: ERROR while processing customer.subscription.updated:',
                        err
                    );
                }
                break;
            }

            case 'customer.subscription.deleted': {
                const subscription = event.data.object;
                const customerId = subscription.customer;
                console.log(
                    `Backend: customer.subscription.deleted ${subscription.id}`
                );

                try {
                    const user = await User.findOne({ stripeCustomerId: customerId });
                    if (user) {
                        user.isSubscribed = false;
                        user.stripeSubscriptionId = undefined;
                        user.trialExpires = undefined;
                        user.trialEmailRemindersSent = [];
                        await user.save();
                        console.log(
                            `Backend: user ${user._id} set isSubscribed=false (subscription.deleted)`
                        );

                        // Optional: email user about cancellation if you want
                        if (subscriptionConfirmationTemplate) {
                            try {
                                await sendEmail({
                                    email: user.email,
                                    subject:
                                        'Your Konar Premium Subscription has been Cancelled',
                                    message: subscriptionConfirmationTemplate(
                                        user.name,
                                        null,
                                        'subscription_cancelled'
                                    ),
                                });
                            } catch (emailErr) {
                                console.error('Backend: cancellation email error:', emailErr);
                            }
                        }
                    } else {
                        console.warn(
                            `Backend: No user found for stripeCustomerId ${customerId} (subscription.deleted)`
                        );
                    }
                } catch (err) {
                    console.error(
                        'Backend: ERROR while processing customer.subscription.deleted:',
                        err
                    );
                }
                break;
            }

            case 'invoice.payment_succeeded': {
                const invoice = event.data.object;
                console.log(
                    `Backend: invoice.payment_succeeded ${invoice.id} amount ${(invoice.amount_paid / 100).toFixed(
                        2
                    )}`
                );
                // Optional: persist invoice info or update order status
                break;
            }

            case 'customer.subscription.trial_will_end': {
                const subscription = event.data.object;
                const customerId = subscription.customer;
                console.log(
                    `Backend: customer.subscription.trial_will_end ${subscription.id}`
                );

                try {
                    const user = await User.findOne({ stripeCustomerId: customerId });
                    if (user && subscription.status === 'trialing') {
                        console.log(
                            `Backend: Sending final trial warning email to user ${user._id}`
                        );
                        await sendEmail({
                            email: user.email,
                            subject: 'Your Free Trial is Ending Soon!',
                            message: trialFinalWarningTemplate(user.name),
                        });
                    } else {
                        console.log(
                            `Backend: No email sent. User not found or not trialing.`
                        );
                    }
                } catch (err) {
                    console.error(
                        `Backend: Error in customer.subscription.trial_will_end:`,
                        err
                    );
                }
                break;
            }

            default:
                console.log(`Backend: Unhandled event ${event.type}`);
        }

        // Always 200 after successful handling
        res.status(200).send('OK');
        console.log('Backend: Webhook processed and 200 returned.');
    } catch (err) {
        // If your logic throws, still tell Stripe it failed so it can retry
        console.error('Backend: Webhook handler error:', err);
        res.status(500).send('Webhook handler error');
    }
};
