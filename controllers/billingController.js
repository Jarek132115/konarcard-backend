// backend/controllers/billingController.js
const Stripe = require("stripe");
const User = require("../models/user");

const stripeSecret = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeSecret ? Stripe(stripeSecret) : null;

const isoFromUnixSeconds = (unixSeconds) => {
    if (!unixSeconds) return null;
    try {
        return new Date(unixSeconds * 1000).toISOString();
    } catch {
        return null;
    }
};

const isoFromDateLike = (v) => {
    if (!v) return null;
    try {
        const d = v instanceof Date ? v : new Date(v);
        if (Number.isNaN(d.getTime())) return null;
        return d.toISOString();
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
// GET /api/billing/summary
// ----------------------------------------------------
const getBillingSummary = async (req, res) => {
    try {
        noStore(res);

        if (!req.user) return res.status(401).json({ error: "Unauthorized" });

        const user = await User.findById(req.user._id).lean();
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const account = {
            name: user.name || "",
            email: user.email || "",
            avatar: user.avatar || user.picture || "",
            authProvider: user.authProvider || "local",
            googleEmail: user.googleEmail || null,
            googleId: user.googleId || null,
        };

        // Stripe not configured
        if (!stripe) {
            return res.json({
                ok: true,
                stripeConfigured: false,
                customerExists: !!user.stripeCustomerId,
                account,
                plan: user.plan || "free",
                planInterval: user.planInterval || null,
                subscriptionStatus: user.subscriptionStatus || "free",
                currentPeriodEnd: isoFromDateLike(user.currentPeriodEnd),
                stripeCustomerId: user.stripeCustomerId || null,
                stripeSubscriptionId: user.stripeSubscriptionId || null,
            });
        }

        // No customer => free
        if (!user.stripeCustomerId) {
            return res.json({
                ok: true,
                stripeConfigured: true,
                customerExists: false,
                account,
                plan: user.plan || "free",
                planInterval: user.planInterval || null,
                subscriptionStatus: user.subscriptionStatus || "free",
                currentPeriodEnd: isoFromDateLike(user.currentPeriodEnd),
                stripeCustomerId: null,
                stripeSubscriptionId: user.stripeSubscriptionId || null,
            });
        }

        // ------------------------------
        // 1) Try Stripe subscription
        // ------------------------------
        let subscription = null;

        if (user.stripeSubscriptionId) {
            try {
                subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
            } catch {
                subscription = null;
            }
        }

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

        // Prefer DB -> then Stripe sub
        let currentPeriodEndISO =
            isoFromDateLike(user.currentPeriodEnd) ||
            isoFromUnixSeconds(subscription?.current_period_end);

        // ------------------------------
        // 2) Fallback: derive renew date from latest invoice line period end
        // (This fixes cases where subscription fetch fails / returns no current_period_end)
        // ------------------------------
        if (!currentPeriodEndISO) {
            try {
                const inv = await stripe.invoices.list({
                    customer: user.stripeCustomerId,
                    limit: 1,
                });

                const latest = inv?.data?.[0];
                const linePeriodEnd = latest?.lines?.data?.[0]?.period?.end;

                // Stripe gives unix seconds
                currentPeriodEndISO = isoFromUnixSeconds(linePeriodEnd);
            } catch {
                // ignore
            }
        }

        return res.json({
            ok: true,
            stripeConfigured: true,
            customerExists: true,
            account,

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
            created: isoFromUnixSeconds(inv.created),
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
            created: isoFromUnixSeconds(pi.created),
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
