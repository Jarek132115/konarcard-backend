// routes/checkout.js
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
                    price: 'price_1RWz48P7pC1ilLXAGhstIic4', 
                    quantity: quantity || 1,
                },
            ],
            mode: 'payment',
            success_url: 'http://localhost:5173/success',
            cancel_url: 'http://localhost:5173/shopnfccards/whitecard',
        });

        res.json({ id: session.id });
    } catch (err) {
        console.error('Stripe error:', err);
        res.status(500).json({ error: 'Stripe session failed' });
    }
});

module.exports = router;
