const express = require('express');
const router = express.Router();
const sendEmail = require('../utils/SendEmail');
const { contactFormAdminTemplate } = require('../utils/emailTemplates');

router.post('/', async (req, res) => {
    try {
        const { name, email, reason, message } = req.body;

        if (!name || !email || !message || !reason) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        const html = contactFormAdminTemplate(name, email, reason, message);

        await sendEmail(
            'supportteam@konarcard.com',
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
