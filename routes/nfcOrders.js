const express = require("express");
const router = express.Router();

const { requireAuth } = require("../helpers/auth");
const NfcOrder = require("../models/NfcOrder");

function normalizeOrderStatus(raw) {
    const s = String(raw || "").trim().toLowerCase();

    if (["paid", "processing", "fulfilled", "shipped", "complete", "completed"].includes(s)) {
        return "paid";
    }

    if (["pending", "open", "unpaid", "draft"].includes(s)) {
        return "pending";
    }

    if (["cancelled", "canceled", "expired"].includes(s)) {
        return "cancelled";
    }

    if (["failed", "payment_failed"].includes(s)) {
        return "failed";
    }

    return s || "pending";
}

function normalizeFulfillmentStatus(raw) {
    const s = String(raw || "").trim().toLowerCase();

    if (
        ["order_placed", "designing_card", "packaged", "shipped", "delivered"].includes(s)
    ) {
        return s;
    }

    return "order_placed";
}

function decorateOrder(order) {
    const normalizedStatus = normalizeOrderStatus(order?.status);
    const fulfillmentStatus = normalizeFulfillmentStatus(order?.fulfillmentStatus);

    return {
        ...order,
        normalizedStatus,
        fulfillmentStatus,
        isPurchased: normalizedStatus === "paid",
        isPending: normalizedStatus === "pending",
        isCancelled: normalizedStatus === "cancelled",
        isFailed: normalizedStatus === "failed",
        isActive: normalizedStatus === "paid" || normalizedStatus === "pending",
    };
}

router.get("/mine", requireAuth, async (req, res) => {
    try {
        const userId = req.user?._id;
        if (!userId) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const rawOrders = await NfcOrder.find({ user: userId })
            .populate("profile", "profile_slug business_card_name full_name main_heading")
            .sort({ createdAt: -1 })
            .lean();

        const orders = (Array.isArray(rawOrders) ? rawOrders : []).map(decorateOrder);

        const purchasedOrders = orders.filter((o) => o.isPurchased);
        const pendingOrders = orders.filter((o) => o.isPending);
        const cancelledOrders = orders.filter((o) => o.isCancelled || o.isFailed);
        const activeOrders = orders.filter((o) => o.isActive);

        return res.json({
            ok: true,
            orders,
            purchasedOrders,
            activeOrders,
            pendingOrders,
            cancelledOrders,
        });
    } catch (err) {
        console.error("GET /nfc-orders/mine error:", err);
        return res.status(500).json({ error: "Failed to load orders" });
    }
});

module.exports = router;