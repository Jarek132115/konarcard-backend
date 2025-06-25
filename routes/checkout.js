const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY); // This will use your live secret key from env

router.post('/create-checkout-session', async (req, res) => {
    const { quantity } = req.body;

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    // IMPORTANT: Now using the NEW environment variable name: STRIPE_WHITE_CARD_PRICE_ID
                    price: process.env.STRIPE_WHITE_CARD_PRICE_ID, // This will be your live £19.95 price ID
                    quantity: quantity || 1,
                },
            ],
            mode: 'payment',
            success_url: `${process.env.CLIENT_URL}/success`,
            cancel_url: `${process.env.CLIENT_URL}/shopnfccards/whitecard`,
        });

        res.json({ id: session.id });
    } catch (err) {
        console.error('Stripe error creating checkout session:', err);
        res.status(500).json({ error: err.message || 'Stripe session failed' });
    }
});

module.exports = router;