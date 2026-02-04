// backend/controllers/billingController.js
const Stripe = require("stripe");
const User = require("../models/user");

const stripeSecret = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeSecret ? Stripe(stripeSecret) : null;

const isoOrNull = (unixSeconds) => {
    if (!unixSeconds) return null;
    try {
        return new Date(unixSeconds * 1000).toISOString();
    } catch {
        return null;
    }
};

const noStore = (res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");
};

// ----------------------------------------------------
// ✅ SETTINGS: Billing summary
// GET /api/billing/summary
// ----------------------------------------------------
const getBillingSummary = async (req, res) => {
    try {
        noStore(res);

        if (!req.user) return res.status(401).json({ error: "Unauthorized" });

        const user = await User.findById(req.user._id).lean();
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        // If Stripe not configured, still return basic info so UI can render safely
        if (!stripe) {
            return res.json({
                ok: true,
                stripeConfigured: false,
                customerExists: !!user.stripeCustomerId,

                account: {
                    name: user.name || "",
                    email: user.email || "",
                    avatar: user.avatar || user.picture || "",
                    authProvider: user.authProvider || "local",
                    googleEmail: user.googleEmail || null,
                    googleId: user.googleId || null,
                },

                plan: user.plan || "free",
                planInterval: user.planInterval || null,
                subscriptionStatus: user.subscriptionStatus || "free",
                currentPeriodEnd: user.currentPeriodEnd ? new Date(user.currentPeriodEnd).toISOString() : null,

                stripeCustomerId: user.stripeCustomerId || null,
                stripeSubscriptionId: user.stripeSubscriptionId || null,
            });
        }

        // No customer => free user
        if (!user.stripeCustomerId) {
            return res.json({
                ok: true,
                stripeConfigured: true,
                customerExists: false,

                account: {
                    name: user.name || "",
                    email: user.email || "",
                    avatar: user.avatar || user.picture || "",
                    authProvider: user.authProvider || "local",
                    googleEmail: user.googleEmail || null,
                    googleId: user.googleId || null,
                },

                plan: user.plan || "free",
                planInterval: user.planInterval || null,
                subscriptionStatus: user.subscriptionStatus || "free",
                currentPeriodEnd: user.currentPeriodEnd ? new Date(user.currentPeriodEnd).toISOString() : null,

                stripeCustomerId: null,
                stripeSubscriptionId: user.stripeSubscriptionId || null,
            });
        }

        // ---------------------------------------
        // Pull latest subscription state from Stripe (best-effort)
        // IMPORTANT: If retrieve fails, FALL BACK to list by customer.
        // ---------------------------------------
        let subscription = null;

        // Try retrieve first if we have an ID
        if (user.stripeSubscriptionId) {
            try {
                subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
            } catch {
                subscription = null;
            }
        }

        // ✅ Fallback: list subs by customer if retrieve failed OR no subscriptionId
        if (!subscription) {
            try {
                const subs = await stripe.subscriptions.list({
                    customer: user.stripeCustomerId,
                    status: "all",
                    limit: 10,
                });

                subscription =
                    subs.data.find((s) => ["active", "trialing"].includes(s.status)) ||
                    subs.data[0] ||
                    null;
            } catch {
                subscription = null;
            }
        }

        const subscriptionStatus = user.subscriptionStatus || subscription?.status || "free";

        // Prefer DB date if present, else Stripe
        const currentPeriodEndISO =
            (user.currentPeriodEnd ? new Date(user.currentPeriodEnd).toISOString() : null) ||
            isoOrNull(subscription?.current_period_end);

        return res.json({
            ok: true,
            stripeConfigured: true,
            customerExists: true,

            account: {
                name: user.name || "",
                email: user.email || "",
                avatar: user.avatar || user.picture || "",
                authProvider: user.authProvider || "local",
                googleEmail: user.googleEmail || null,
                googleId: user.googleId || null,
            },

            plan: user.plan || "free",
            planInterval: user.planInterval || null,
            subscriptionStatus,
            currentPeriodEnd: currentPeriodEndISO,

            stripeCustomerId: user.stripeCustomerId,
            stripeSubscriptionId: user.stripeSubscriptionId || subscription?.id || null,
        });
    } catch (err) {
        console.error("getBillingSummary error:", err);
        return res.status(500).json({ error: "Failed to load billing summary" });
    }
};

// ----------------------------------------------------
// ✅ SETTINGS: List invoices
// GET /api/billing/invoices?limit=10
// ----------------------------------------------------
const listBillingInvoices = async (req, res) => {
    try {
        noStore(res);

        if (!req.user) return res.status(401).json({ error: "Unauthorized" });
        if (!stripe) return res.json({ ok: true, stripeConfigured: false, invoices: [] });

        const user = await User.findById(req.user._id).lean();
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        if (!user.stripeCustomerId) return res.json({ ok: true, stripeConfigured: true, invoices: [] });

        const limit = Math.min(25, Math.max(1, Number(req.query.limit || 10)));

        const invoices = await stripe.invoices.list({
            customer: user.stripeCustomerId,
            limit,
        });

        const cleaned = (invoices.data || []).map((inv) => ({
            id: inv.id,
            number: inv.number || null,
            status: inv.status || null,
            currency: inv.currency || null,

            total: typeof inv.total === "number" ? inv.total : null,
            amount_paid: typeof inv.amount_paid === "number" ? inv.amount_paid : null,
            amount_due: typeof inv.amount_due === "number" ? inv.amount_due : null,

            created: isoOrNull(inv.created),

            hosted_invoice_url: inv.hosted_invoice_url || null,
            invoice_pdf: inv.invoice_pdf || null,
        }));

        return res.json({ ok: true, stripeConfigured: true, invoices: cleaned });
    } catch (err) {
        console.error("listBillingInvoices error:", err);
        return res.status(500).json({ error: "Failed to load invoices" });
    }
};

// ----------------------------------------------------
// ✅ SETTINGS: List payments (PaymentIntents)
// GET /api/billing/payments?limit=10
// ----------------------------------------------------
const listBillingPayments = async (req, res) => {
    try {
        noStore(res);

        if (!req.user) return res.status(401).json({ error: "Unauthorized" });
        if (!stripe) return res.json({ ok: true, stripeConfigured: false, payments: [] });

        const user = await User.findById(req.user._id).lean();
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        if (!user.stripeCustomerId) return res.json({ ok: true, stripeConfigured: true, payments: [] });

        const limit = Math.min(25, Math.max(1, Number(req.query.limit || 10)));

        const payments = await stripe.paymentIntents.list({
            customer: user.stripeCustomerId,
            limit,
        });

        const cleaned = (payments.data || []).map((pi) => ({
            id: pi.id,
            status: pi.status || null,
            currency: pi.currency || null,
            amount: typeof pi.amount === "number" ? pi.amount : null,
            created: isoOrNull(pi.created),
            description: pi.description || null,
            receipt_email: pi.receipt_email || null,
        }));

        return res.json({ ok: true, stripeConfigured: true, payments: cleaned });
    } catch (err) {
        console.error("listBillingPayments error:", err);
        return res.status(500).json({ error: "Failed to load payments" });
    }
};

module.exports = {
    getBillingSummary,
    listBillingInvoices,
    listBillingPayments,
};
