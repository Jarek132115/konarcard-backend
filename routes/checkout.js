const express = require('express');
const router = express.Router();
const Stripe = require('stripe');

if (!process.env.STRIPE_SECRET_KEY) {
    console.error('[Stripe] STRIPE_SECRET_KEY is missing');
}
const stripe = Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2025-04-30.basil', // matches Stripe’s header in your logs
});

// Tiny helper: clamp quantity
const parseQty = (raw) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 1;
    return Math.min(Math.floor(n), 99);
};

router.post('/create-checkout-session', async (req, res) => {
    const quantity = parseQty(req.body?.quantity);
    const clientUrl = process.env.CLIENT_URL || 'https://www.konarcard.com';

    try {
        // Prefer a Price ID if provided; otherwise fall back to price_data
        const priceId = process.env.STRIPE_WHITE_CARD_PRICE_ID;

        /** Build line item */
        const lineItem = priceId
            ? { price: priceId, quantity }
            : {
                price_data: {
                    currency: 'gbp',
                    unit_amount: 2495, // £24.95 (in pence). Keep in sync with your UI.
                    product_data: { name: 'Konar Card - White Edition' },
                },
                quantity,
            };

        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            payment_method_types: ['card'],
            line_items: [lineItem],
            allow_promotion_codes: true,
            // Optional: collect addresses if you ship
            // shipping_address_collection: { allowed_countries: ['GB'] },
            success_url: `${clientUrl}/success`,
            cancel_url: `${clientUrl}/productandplan/konarcard`,
            metadata: {
                // helpful for reconciling orders
                product: 'konar_white_card',
                env_has_price_id: String(Boolean(priceId)),
            },
        });

        return res.json({ id: session.id });
    } catch (err) {
        // Log useful context server-side
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
