// routes/checkout.js (or wherever you mount this router)
const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const User = require('../models/user'); // <<— needed to persist stripeCustomerId

if (!process.env.STRIPE_SECRET_KEY) {
    console.error('[Stripe] STRIPE_SECRET_KEY is missing');
}
const stripe = Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2025-04-30.basil',
});

// ---- helpers ---------------------------------------------------------------

const parseQty = (raw) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 1;
    return Math.min(Math.floor(n), 99);
};

async function ensureStripeCustomerForUser(user) {
    if (user.stripeCustomerId) {
        try {
            const c = await stripe.customers.retrieve(user.stripeCustomerId);
            if (!c.deleted) return user.stripeCustomerId;
        } catch {
            // fall through and create
        }
    }
    const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: { userId: user._id.toString() },
    });
    user.stripeCustomerId = customer.id;
    await user.save();
    return customer.id;
}

// ---- routes ----------------------------------------------------------------

router.post('/create-checkout-session', async (req, res) => {
    try {
        // Require auth (JWT middleware should populate req.user.id)
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const quantity = parseQty(req.body?.quantity);
        const clientUrl = process.env.CLIENT_URL || 'https://www.konarcard.com';

        // Make sure we attach THIS user’s Stripe customer to the session
        const customerId = await ensureStripeCustomerForUser(user);

        // Prefer a Price ID if provided; otherwise fall back to price_data
        const priceId = process.env.STRIPE_WHITE_CARD_PRICE_ID;
        const lineItem = priceId
            ? { price: priceId, quantity }
            : {
                price_data: {
                    currency: 'gbp',
                    unit_amount: 2495, // £24.95 (in pence)
                    product_data: { name: 'Konar Card - White Edition' },
                },
                quantity,
            };

        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            customer: customerId,                           // <<— tie session to user
            client_reference_id: user._id.toString(),
            payment_method_types: ['card'],
            line_items: [lineItem],
            allow_promotion_codes: true,

            // ✅ Collect shipping address so we can mirror it into the order
            shipping_address_collection: { allowed_countries: ['GB'] },

            // Include session id on success for easier debugging if you want
            success_url: `${clientUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${clientUrl}/productandplan/konarcard`,

            metadata: {
                userId: user._id.toString(),
                kind: 'konar_card',
                quantity: String(quantity),
                env_has_price_id: String(Boolean(priceId)),
            },
        });

        return res.status(200).json({ id: session.id, url: session.url });
    } catch (err) {
        console.error('Stripe error creating checkout session:', {
            message: err?.message,
            type: err?.type,
            code: err?.code,
            param: err?.param,
        });
        const friendly =
            err?.message?.includes('price') || err?.param === 'line_items[0]'
                ? 'Checkout configuration error (price). Please contact support.'
                : err?.message || 'Stripe session failed';
        return res.status(500).json({ error: friendly });
    }
});

module.exports = router;
