const express = require('express');
const router = express.Router();
const sendEmail = require('../utils/SendEmail');

router.post('/', async (req, res) => {
    try {
        const { name, email, reason, message } = req.body;

        if (!name || !email || !message || !reason) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        const html = `
      <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>New Contact Message</h2>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Reason:</strong> ${reason}</p>
        <p><strong>Message:</strong></p>
        <p>${message}</p>
      </div>
    `;

        await sendEmail(
            'supportteam@konarcard.com',  // your target inbox
            `New Contact Form: ${reason}`,
            html
        );

        res.json({ success: true, message: 'Message sent' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

module.exports = router;
