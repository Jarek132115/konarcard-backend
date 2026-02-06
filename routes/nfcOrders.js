// backend/routes/nfcOrders.js
const express = require("express");
const router = express.Router();

const { requireAuth } = require("../helpers/auth");
const NfcOrder = require("../models/NfcOrder");

router.get("/mine", requireAuth, async (req, res) => {
    try {
        const userId = req.user?._id;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const orders = await NfcOrder.find({ user: userId })
            .populate("profile", "profile_slug business_card_name full_name main_heading")
            .sort({ createdAt: -1 })
            .lean();

        return res.json({ ok: true, orders });
    } catch (err) {
        console.error("GET /nfc-orders/mine error:", err);
        return res.status(500).json({ error: "Failed to load orders" });
    }
});

module.exports = router;
