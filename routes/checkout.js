const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY); 

router.post('/create-checkout-session', async (req, res) => {
    const { quantity } = req.body;

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price: process.env.STRIPE_WHITE_CARD_PRICE_ID, 
                    quantity: quantity || 1,
                },
            ],
            mode: 'payment',
            success_url: `${process.env.CLIENT_URL}/success`,
            cancel_url: `${process.env.CLIENT_URL}/shopnfccards/konarcard`,
        });

        res.json({ id: session.id });
    } catch (err) {
        console.error('Stripe error creating checkout session:', err);
        res.status(500).json({ error: err.message || 'Stripe session failed' });
    }
});

module.exports = router;