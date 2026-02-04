// backend/controllers/publicController.js
const ContactExchange = require("../models/ContactExchange");
const BusinessCard = require("../models/BusinessCard");
const User = require("../models/user");
const sendEmail = require("../utils/SendEmail");
const { contactExchangeTemplate } = require("../utils/emailTemplates");

exports.exchangeContact = async (req, res) => {
    try {
        const {
            profileSlug,
            name,
            email,
            phone,
            message,
        } = req.body || {};

        // -----------------------
        // Basic validation
        // -----------------------
        if (!profileSlug) {
            return res.status(400).json({ error: "Missing profile slug." });
        }

        if (!name || typeof name !== "string") {
            return res.status(400).json({ error: "Name is required." });
        }

        if (!email && !phone) {
            return res.status(400).json({ error: "Email or phone is required." });
        }

        const slug = String(profileSlug).trim().toLowerCase();

        // -----------------------
        // Find business card
        // -----------------------
        const businessCard = await BusinessCard.findOne({ slug }).populate("user");

        if (!businessCard || !businessCard.user) {
            return res.status(404).json({ error: "Profile not found." });
        }

        const owner = businessCard.user;

        // -----------------------
        // Store exchange
        // -----------------------
        await ContactExchange.create({
            profile_slug: slug,
            owner_user: owner._id,
            business_card: businessCard._id,
            visitor_name: name.trim(),
            visitor_email: email?.trim().toLowerCase() || undefined,
            visitor_phone: phone?.trim() || undefined,
            message: message?.trim() || undefined,
            ip: req.headers["x-forwarded-for"] || req.ip,
            user_agent: req.headers["user-agent"],
        });

        // -----------------------
        // Email owner
        // -----------------------
        if (owner.email) {
            await sendEmail({
                to: owner.email,
                subject: "New contact from your KonarCard",
                html: contactExchangeTemplate(
                    owner.name || owner.email,
                    slug,
                    {
                        visitor_name: name,
                        visitor_email: email,
                        visitor_phone: phone,
                        message,
                    }
                ),
            });
        }

        return res.json({ success: true });
    } catch (err) {
        console.error("exchangeContact error:", err);
        return res.status(500).json({ error: "Something went wrong." });
    }
};
