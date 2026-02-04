// backend/controllers/publicController.js
const ContactExchange = require("../models/ContactExchange");
const BusinessCard = require("../models/BusinessCard");
const sendEmail = require("../utils/SendEmail");
const { contactExchangeTemplate } = require("../utils/emailTemplates");

const cleanText = (v, max = 500) => String(v || "").trim().slice(0, max);
const cleanEmail = (v) => String(v || "").trim().toLowerCase();
const cleanPhone = (v) => String(v || "").replace(/[^\d+]/g, "").slice(0, 20);

const normalizeSlug = (v) =>
    String(v || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

const getClientIp = (req) => {
    const xf = req.headers["x-forwarded-for"];
    if (xf) return String(xf).split(",")[0].trim();
    return req.ip;
};

/* =========================================================
   PUBLIC: visitor submits exchange
   POST /exchange-contact
========================================================= */
exports.exchangeContact = async (req, res) => {
    try {
        const profileSlug = normalizeSlug(req.body?.profileSlug);
        const name = cleanText(req.body?.name, 80);
        const email = cleanEmail(req.body?.email);
        const phone = cleanPhone(req.body?.phone);
        const message = cleanText(req.body?.message, 500);

        if (!profileSlug) return res.status(400).json({ error: "Missing profile slug." });
        if (!name) return res.status(400).json({ error: "Name is required." });
        if (!email && !phone) return res.status(400).json({ error: "Email or phone is required." });

        // Find business card by profile_slug (preferred) or slug (fallback)
        const businessCard =
            (await BusinessCard.findOne({ profile_slug: profileSlug }).populate("user")) ||
            (await BusinessCard.findOne({ slug: profileSlug }).populate("user"));

        if (!businessCard || !businessCard.user) return res.status(404).json({ error: "Profile not found." });

        const owner = businessCard.user;

        const record = await ContactExchange.create({
            profile_slug: profileSlug,
            owner_user: owner._id,
            business_card: businessCard._id,
            visitor_name: name,
            visitor_email: email || undefined,
            visitor_phone: phone || undefined,
            message: message || undefined,
            ip: getClientIp(req),
            user_agent: String(req.headers["user-agent"] || "").slice(0, 300),
        });

        // email owner (don’t fail request if email fails)
        if (owner.email) {
            try {
                const html = contactExchangeTemplate(owner.name || owner.email, profileSlug, {
                    visitor_name: name,
                    visitor_email: email,
                    visitor_phone: phone,
                    message,
                });

                // Your SendEmail util expects: (to, subject, html)
                await sendEmail(owner.email, "New contact from your KonarCard", html);
            } catch (e) {
                console.error("[exchangeContact] email failed:", e?.message || e);
            }
        }

        return res.json({ success: true, id: record._id });
    } catch (err) {
        console.error("exchangeContact error:", err);
        return res.status(500).json({ error: "Something went wrong." });
    }
};

/* =========================================================
   PROTECTED: owner views their exchanges (Contact Book)
   GET /contact-exchanges
========================================================= */
exports.listMyContactExchanges = async (req, res) => {
    try {
        const userId = req.user?._id;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const items = await ContactExchange.find({ owner_user: userId })
            .sort({ createdAt: -1 })
            .limit(500)
            .lean();

        return res.json(items);
    } catch (err) {
        console.error("listMyContactExchanges error:", err);
        return res.status(500).json({ error: "Failed to load contacts" });
    }
};

/* =========================================================
   PROTECTED: owner deletes an exchange
   DELETE /contact-exchanges/:id
========================================================= */
exports.deleteMyContactExchange = async (req, res) => {
    try {
        const userId = req.user?._id;
        const id = req.params.id;

        if (!userId) return res.status(401).json({ error: "Unauthorized" });
        if (!id) return res.status(400).json({ error: "Missing id" });

        const found = await ContactExchange.findOne({ _id: id, owner_user: userId }).lean();
        if (!found) return res.status(404).json({ error: "Not found" });

        await ContactExchange.deleteOne({ _id: id, owner_user: userId });
        return res.json({ success: true });
    } catch (err) {
        console.error("deleteMyContactExchange error:", err);
        return res.status(500).json({ error: "Failed to delete contact" });
    }
};
