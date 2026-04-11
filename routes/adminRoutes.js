const express = require("express");
const router = express.Router();

const { requireAuth } = require("../helpers/auth");
const requireAdmin = require("../helpers/requireAdmin");

const User = require("../models/user");
const BusinessCard = require("../models/BusinessCard");
const NfcOrder = require("../models/NfcOrder");

const sendEmail = require("../utils/SendEmail");

const ADMIN_ORDER_STATUS_OPTIONS = [
    "order_placed",
    "designing_card",
    "packaged",
    "shipped",
    "delivered",
];

const PAID_ORDER_STATUSES = [
    "paid",
    "processing",
    "fulfilled",
    "shipped",
    "complete",
    "completed",
];

const PUBLIC_PROFILE_DOMAIN =
    process.env.PUBLIC_PROFILE_DOMAIN || "https://www.konarcard.com";

function cleanString(v, max = 500) {
    return String(v || "").trim().slice(0, max);
}

function cleanLower(v, max = 120) {
    return cleanString(v, max).toLowerCase();
}

function safeEmail(v) {
    return cleanLower(v, 240);
}

function toObjectIdString(v) {
    return String(v || "").trim();
}

function normalizeFulfillmentStatus(v) {
    const value = cleanLower(v, 60);

    if (value === "preparing_card") return "designing_card";
    if (ADMIN_ORDER_STATUS_OPTIONS.includes(value)) return value;

    return "order_placed";
}

function buildOrderStatusLabel(status) {
    switch (normalizeFulfillmentStatus(status)) {
        case "order_placed":
            return "Order placed";
        case "designing_card":
            return "Card is being prepared";
        case "packaged":
            return "Packaged";
        case "shipped":
            return "Shipment is on the way";
        case "delivered":
            return "Delivered";
        default:
            return "Order updated";
    }
}

function formatMoneyMinor(amount, currency = "gbp") {
    if (typeof amount !== "number" || !Number.isFinite(amount)) return "—";

    try {
        return new Intl.NumberFormat("en-GB", {
            style: "currency",
            currency: String(currency || "gbp").toUpperCase(),
        }).format(amount / 100);
    } catch {
        return `${(amount / 100).toFixed(2)} ${String(currency || "gbp").toUpperCase()}`;
    }
}

function buildSearchRegex(q) {
    const value = cleanString(q, 120);
    if (!value) return null;
    return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

function bestUserName(user) {
    return (
        cleanString(user?.name, 120) ||
        cleanString(user?.username, 120) ||
        cleanString(user?.email, 120) ||
        "User"
    );
}

function normalizeSlug(v) {
    return cleanLower(v, 120)
        .replace(/[^a-z0-9-]/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}

function buildPublicProfileUrl(slug) {
    const safeSlug = normalizeSlug(slug);
    return safeSlug ? `${PUBLIC_PROFILE_DOMAIN}/u/${safeSlug}` : "";
}

function buildTrackingEmailHtml({ user, order, trackingUrl, deliveryWindow }) {
    const name = bestUserName(user);
    const amount = formatMoneyMinor(order?.amountTotal, order?.currency);

    return `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827;padding:24px;">
      <h2 style="margin:0 0 16px;">Your KonarCard order has shipped</h2>
      <p style="margin:0 0 12px;">Hi ${name},</p>
      <p style="margin:0 0 12px;">
        Your order is on the way${amount !== "—" ? ` (${amount})` : ""}.
      </p>
      ${trackingUrl
            ? `<p style="margin:0 0 12px;"><strong>Tracking link:</strong> <a href="${trackingUrl}" target="_blank" rel="noreferrer">${trackingUrl}</a></p>`
            : ""
        }
      ${deliveryWindow
            ? `<p style="margin:0 0 12px;"><strong>Estimated delivery:</strong> ${deliveryWindow}</p>`
            : ""
        }
      <p style="margin:20px 0 0;">Thanks,<br/>KonarCard Support</p>
    </div>
  `;
}

function buildStatusEmailHtml({ user, status, trackingUrl }) {
    const name = bestUserName(user);
    const label = buildOrderStatusLabel(status);

    return `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827;padding:24px;">
      <h2 style="margin:0 0 16px;">Your KonarCard order update</h2>
      <p style="margin:0 0 12px;">Hi ${name},</p>
      <p style="margin:0 0 12px;">
        Your order status is now: <strong>${label}</strong>.
      </p>
      ${trackingUrl && normalizeFulfillmentStatus(status) === "shipped"
            ? `<p style="margin:0 0 12px;"><strong>Tracking link:</strong> <a href="${trackingUrl}" target="_blank" rel="noreferrer">${trackingUrl}</a></p>`
            : ""
        }
      <p style="margin:20px 0 0;">Thanks,<br/>KonarCard Support</p>
    </div>
  `;
}

function extractOrderCustomerName(order) {
    return (
        cleanString(order?.deliveryName, 120) ||
        cleanString(order?.metadata?.deliveryName, 120) ||
        cleanString(order?.shipping?.name, 120) ||
        cleanString(order?.customerName, 120) ||
        cleanString(order?.user?.name, 120) ||
        "—"
    );
}

function extractOrderCustomerEmail(order) {
    return (
        safeEmail(order?.customerEmail) ||
        safeEmail(order?.metadata?.customerEmail) ||
        safeEmail(order?.userEmail) ||
        safeEmail(order?.user?.email) ||
        "—"
    );
}

function extractOrderAddress(order) {
    if (cleanString(order?.deliveryAddress, 300)) return cleanString(order.deliveryAddress, 300);
    if (cleanString(order?.metadata?.deliveryAddress, 300)) {
        return cleanString(order.metadata.deliveryAddress, 300);
    }

    const addr = order?.shipping?.address;
    if (!addr || typeof addr !== "object") return "—";

    const combined = [
        addr.line1,
        addr.line2,
        addr.city,
        addr.state,
        addr.postal_code,
        addr.country,
    ]
        .map((x) => cleanString(x, 120))
        .filter(Boolean)
        .join(", ");

    return combined || "—";
}

function getOrderPreview(order) {
    return order?.preview && typeof order.preview === "object" ? order.preview : {};
}

function getOrderCustomization(order) {
    const preview = getOrderPreview(order);
    const customization =
        preview?.customization && typeof preview.customization === "object"
            ? preview.customization
            : {};

    const frontText =
        cleanString(customization.frontText, 120) ||
        cleanString(preview?.frontText, 120);

    const fontFamily =
        cleanString(customization.fontFamily, 120) ||
        cleanString(preview?.fontFamily, 120);

    const fontWeightRaw =
        customization.fontWeight ??
        preview?.fontWeight ??
        "";

    const fontSizeRaw =
        customization.fontSize ??
        preview?.fontSize ??
        "";

    const orientation =
        cleanString(customization.orientation, 40) ||
        cleanString(preview?.orientation, 40);

    const textColor =
        cleanString(customization.textColor, 40) ||
        cleanString(preview?.textColor, 40);

    return {
        frontText,
        fontFamily,
        fontWeight:
            typeof fontWeightRaw === "number"
                ? fontWeightRaw
                : Number(fontWeightRaw || 0) || 0,
        fontSize:
            typeof fontSizeRaw === "number"
                ? fontSizeRaw
                : Number(fontSizeRaw || 0) || 0,
        orientation,
        textColor,
    };
}

function getProfileSlugFromOrder(order) {
    const preview = getOrderPreview(order);

    return (
        cleanString(order?.profile?.profile_slug, 120) ||
        cleanString(preview?.profileSlug, 120) ||
        cleanString(order?.metadata?.profileSlug, 120) ||
        cleanString(order?.metadata?.profile_slug, 120) ||
        ""
    );
}

function getPublicProfileUrlFromOrder(order) {
    const preview = getOrderPreview(order);
    const profileSlug = getProfileSlugFromOrder(order);

    return (
        cleanString(preview?.publicProfileUrl, 1200) ||
        cleanString(order?.metadata?.publicProfileUrl, 1200) ||
        cleanString(order?.metadata?.public_profile_url, 1200) ||
        buildPublicProfileUrl(profileSlug)
    );
}

function getQrTargetUrlFromOrder(order) {
    const preview = getOrderPreview(order);
    const publicProfileUrl = getPublicProfileUrlFromOrder(order);

    return (
        cleanString(order?.qrCodeUrl, 1200) ||
        cleanString(order?.qrTargetUrl, 1200) ||
        cleanString(preview?.qrCodeUrl, 1200) ||
        cleanString(preview?.qrTargetUrl, 1200) ||
        cleanString(preview?.publicProfileUrl, 1200) ||
        cleanString(order?.profile?.qr_code_url, 1200) ||
        cleanString(order?.metadata?.qrCodeUrl, 1200) ||
        cleanString(order?.metadata?.qrTargetUrl, 1200) ||
        cleanString(order?.metadata?.qr_code_url, 1200) ||
        publicProfileUrl
    );
}

function getNfcTargetUrlFromOrder(order) {
    const preview = getOrderPreview(order);
    const publicProfileUrl = getPublicProfileUrlFromOrder(order);

    return (
        cleanString(order?.nfcTargetUrl, 1200) ||
        cleanString(order?.nfcUrl, 1200) ||
        cleanString(preview?.nfcTargetUrl, 1200) ||
        cleanString(preview?.nfcUrl, 1200) ||
        cleanString(order?.metadata?.nfcTargetUrl, 1200) ||
        cleanString(order?.metadata?.nfcUrl, 1200) ||
        cleanString(preview?.publicProfileUrl, 1200) ||
        publicProfileUrl
    );
}

function serializeOrder(order) {
    const user = order?.user || null;
    const profile = order?.profile || null;
    const preview = getOrderPreview(order);
    const customization = getOrderCustomization(order);

    const profileSlug = getProfileSlugFromOrder(order);
    const publicProfileUrl = getPublicProfileUrlFromOrder(order);
    const qrTargetUrl = getQrTargetUrlFromOrder(order);
    const nfcTargetUrl = getNfcTargetUrlFromOrder(order);

    return {
        _id: order?._id?.toString?.() || String(order?._id || ""),
        userId: user?._id?.toString?.() || order?.user?.toString?.() || "",
        profileId: profile?._id?.toString?.() || order?.profile?.toString?.() || "",

        status: cleanString(order?.status, 60) || "pending",
        fulfillmentStatus: normalizeFulfillmentStatus(order?.fulfillmentStatus),
        trackingUrl: cleanString(order?.trackingUrl, 1200),
        trackingCode: cleanString(order?.trackingCode, 120),
        deliveryWindow: cleanString(order?.deliveryWindow, 160),

        amountTotal: typeof order?.amountTotal === "number" ? order.amountTotal : 0,
        amountTotalFormatted: formatMoneyMinor(order?.amountTotal, order?.currency),
        currency: cleanLower(order?.currency, 12) || "gbp",
        quantity: Number(order?.quantity || 1),

        productKey: cleanString(order?.productKey, 80),
        variant: cleanString(order?.variant, 80),

        logoUrl: cleanString(order?.logoUrl, 1200),
        previewImageUrl: cleanString(order?.previewImageUrl, 1200),

        qrCodeUrl: qrTargetUrl,
        qrTargetUrl,
        nfcTargetUrl,
        publicProfileUrl,
        profileSlug,

        preview: preview || {},
        previewMeta: {
            family: cleanString(preview?.family, 80),
            edition: cleanString(preview?.edition, 80),
            variant: cleanString(preview?.variant, 80),
            profileSlug,
            styleKey: cleanString(preview?.styleKey, 120),
            frontTemplate: cleanString(preview?.frontTemplate, 120),
            backTemplate: cleanString(preview?.backTemplate, 120),
            usesPresetArtwork: !!preview?.usesPresetArtwork,
        },

        customization,

        customerName: extractOrderCustomerName(order),
        customerEmail: extractOrderCustomerEmail(order),
        deliveryName: extractOrderCustomerName(order),
        deliveryAddress: extractOrderAddress(order),

        user: user
            ? {
                _id: user._id?.toString?.() || "",
                name: cleanString(user.name, 120),
                email: safeEmail(user.email),
                username: cleanString(user.username, 120),
                role: cleanLower(user.role, 20) || "user",
                plan: cleanLower(user.plan, 40) || "free",
                subscriptionStatus: cleanLower(user.subscriptionStatus, 40) || "free",
                teamsProfilesQty: Number(user.teamsProfilesQty || 1),
                extraProfilesQty: Number(user.extraProfilesQty || 0),
                createdAt: user.createdAt || null,
            }
            : null,

        profile: profile
            ? {
                _id: profile._id?.toString?.() || "",
                profile_slug: cleanString(profile.profile_slug, 120),
                business_card_name: cleanString(profile.business_card_name, 120),
                full_name: cleanString(profile.full_name, 120),
                qr_code_url: cleanString(profile.qr_code_url, 1200),
            }
            : null,

        createdAt: order?.createdAt || null,
        updatedAt: order?.updatedAt || null,
    };
}

router.use(requireAuth, requireAdmin);

/**
 * GET /api/admin/summary
 */
router.get("/summary", async (req, res) => {
    try {
        const [totalUsers, totalProfiles, totalOrders, activeSubscribers, paidOrders] =
            await Promise.all([
                User.countDocuments({}),
                BusinessCard.countDocuments({}),
                NfcOrder.countDocuments({}),
                User.countDocuments({
                    subscriptionStatus: { $in: ["active", "trialing"] },
                }),
                NfcOrder.countDocuments({
                    status: {
                        $in: PAID_ORDER_STATUSES,
                    },
                }),
            ]);

        return res.json({
            ok: true,
            data: {
                totalUsers,
                totalProfiles,
                totalOrders,
                activeSubscribers,
                paidOrders,
            },
        });
    } catch (err) {
        console.error("GET /api/admin/summary error:", err);
        return res.status(500).json({ error: "Failed to load admin summary" });
    }
});

/**
 * GET /api/admin/users
 */
router.get("/users", async (req, res) => {
    try {
        const qRaw = cleanString(req.query?.q, 120);
        const q = buildSearchRegex(qRaw);

        const userQuery = q
            ? {
                $or: [
                    { email: q },
                    { name: q },
                    { username: q },
                    { slug: q },
                ],
            }
            : {};

        let users = await User.find(userQuery)
            .select(
                "name email username slug role plan planInterval subscriptionStatus teamsProfilesQty extraProfilesQty isVerified createdAt profileUrl"
            )
            .sort({ createdAt: -1 })
            .lean();

        if (qRaw && !q && qRaw.length >= 12) {
            const directId = users.find((u) => String(u._id) === qRaw);
            if (directId) users = [directId];
        }

        const userIds = users.map((u) => u._id);
        const [profilesAgg, ordersAgg] = await Promise.all([
            BusinessCard.aggregate([
                { $match: { user: { $in: userIds } } },
                { $group: { _id: "$user", count: { $sum: 1 }, slugs: { $push: "$profile_slug" } } },
            ]),
            NfcOrder.aggregate([
                { $match: { user: { $in: userIds } } },
                {
                    $group: {
                        _id: "$user",
                        count: { $sum: 1 },
                        paidCount: {
                            $sum: {
                                $cond: [
                                    {
                                        $in: ["$status", PAID_ORDER_STATUSES],
                                    },
                                    1,
                                    0,
                                ],
                            },
                        },
                    },
                },
            ]),
        ]);

        const profilesMap = new Map(
            profilesAgg.map((x) => [String(x._id), { count: x.count || 0, slugs: x.slugs || [] }])
        );

        const ordersMap = new Map(
            ordersAgg.map((x) => [
                String(x._id),
                { count: x.count || 0, paidCount: x.paidCount || 0 },
            ])
        );

        const data = users.map((u) => {
            const id = String(u._id);
            const p = profilesMap.get(id) || { count: 0, slugs: [] };
            const o = ordersMap.get(id) || { count: 0, paidCount: 0 };

            return {
                _id: id,
                name: cleanString(u.name, 120),
                email: safeEmail(u.email),
                username: cleanString(u.username, 120),
                slug: cleanString(u.slug, 120),
                profileUrl: cleanString(u.profileUrl, 1200),
                role: cleanLower(u.role, 20) || "user",
                plan: cleanLower(u.plan, 20) || "free",
                planInterval: cleanLower(u.planInterval, 20) || "monthly",
                subscriptionStatus: cleanLower(u.subscriptionStatus, 40) || "free",
                teamsProfilesQty: Number(u.teamsProfilesQty || 1),
                extraProfilesQty: Number(u.extraProfilesQty || 0),
                isVerified: !!u.isVerified,
                createdAt: u.createdAt || null,
                profileCount: p.count,
                profileSlugs: p.slugs,
                orderCount: o.count,
                paidOrderCount: o.paidCount,
            };
        });

        return res.json({ ok: true, data });
    } catch (err) {
        console.error("GET /api/admin/users error:", err);
        return res.status(500).json({ error: "Failed to load users" });
    }
});

/**
 * GET /api/admin/users/:id
 */
router.get("/users/:id", async (req, res) => {
    try {
        const userId = toObjectIdString(req.params.id);
        if (!userId) {
            return res.status(400).json({ error: "User id is required" });
        }

        const user = await User.findById(userId)
            .select(
                "name email username slug role plan planInterval subscriptionStatus teamsProfilesQty extraProfilesQty isVerified createdAt currentPeriodEnd profileUrl stripeCustomerId stripeSubscriptionId"
            )
            .lean();

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        const [profiles, orders] = await Promise.all([
            BusinessCard.find({ user: userId })
                .select("profile_slug business_card_name full_name business_name trade_title createdAt qr_code_url")
                .sort({ createdAt: -1 })
                .lean(),
            NfcOrder.find({ user: userId })
                .populate("profile", "profile_slug business_card_name full_name qr_code_url")
                .sort({ createdAt: -1 })
                .lean(),
        ]);

        return res.json({
            ok: true,
            data: {
                user: {
                    _id: String(user._id),
                    name: cleanString(user.name, 120),
                    email: safeEmail(user.email),
                    username: cleanString(user.username, 120),
                    slug: cleanString(user.slug, 120),
                    role: cleanLower(user.role, 20) || "user",
                    plan: cleanLower(user.plan, 20) || "free",
                    planInterval: cleanLower(user.planInterval, 20) || "monthly",
                    subscriptionStatus: cleanLower(user.subscriptionStatus, 40) || "free",
                    teamsProfilesQty: Number(user.teamsProfilesQty || 1),
                    extraProfilesQty: Number(user.extraProfilesQty || 0),
                    isVerified: !!user.isVerified,
                    createdAt: user.createdAt || null,
                    currentPeriodEnd: user.currentPeriodEnd || null,
                    profileUrl: cleanString(user.profileUrl, 1200),
                    stripeCustomerId: cleanString(user.stripeCustomerId, 120),
                    stripeSubscriptionId: cleanString(user.stripeSubscriptionId, 120),
                },
                profiles: (profiles || []).map((p) => ({
                    _id: String(p._id),
                    profile_slug: cleanString(p.profile_slug, 120),
                    business_card_name: cleanString(p.business_card_name, 120),
                    full_name: cleanString(p.full_name, 120),
                    business_name: cleanString(p.business_name, 120),
                    trade_title: cleanString(p.trade_title, 120),
                    qrCodeUrl: cleanString(p.qr_code_url, 1200),
                    publicUrl: p.profile_slug ? buildPublicProfileUrl(p.profile_slug) : "",
                    createdAt: p.createdAt || null,
                })),
                orders: (orders || []).map(serializeOrder),
            },
        });
    } catch (err) {
        console.error("GET /api/admin/users/:id error:", err);
        return res.status(500).json({ error: "Failed to load user details" });
    }
});

/**
 * GET /api/admin/orders
 */
router.get("/orders", async (req, res) => {
    try {
        const q = buildSearchRegex(req.query?.q);
        const requestedFulfillmentStatus = cleanLower(req.query?.fulfillmentStatus, 60);

        const mongoQuery = {};

        if (requestedFulfillmentStatus) {
            const normalizedRequestedStatus = normalizeFulfillmentStatus(requestedFulfillmentStatus);

            if (normalizedRequestedStatus === "order_placed") {
                mongoQuery.$or = [
                    { fulfillmentStatus: "order_placed" },
                    { fulfillmentStatus: "preparing_card" },
                    { fulfillmentStatus: { $exists: false } },
                    { fulfillmentStatus: null },
                    { fulfillmentStatus: "" },
                ];
            } else if (normalizedRequestedStatus === "designing_card") {
                mongoQuery.$or = [
                    { fulfillmentStatus: "designing_card" },
                    { fulfillmentStatus: "preparing_card" },
                ];
            } else {
                mongoQuery.fulfillmentStatus = normalizedRequestedStatus;
            }
        }

        let orders = await NfcOrder.find(mongoQuery)
            .populate(
                "user",
                "name email username role plan subscriptionStatus teamsProfilesQty extraProfilesQty createdAt"
            )
            .populate("profile", "profile_slug business_card_name full_name qr_code_url")
            .sort({ createdAt: -1 })
            .lean();

        if (q) {
            orders = orders.filter((o) => {
                const customization = getOrderCustomization(o);
                const profileSlug = getProfileSlugFromOrder(o);
                const publicProfileUrl = getPublicProfileUrlFromOrder(o);
                const qrTargetUrl = getQrTargetUrlFromOrder(o);
                const nfcTargetUrl = getNfcTargetUrlFromOrder(o);

                const haystack = [
                    o?._id?.toString?.(),
                    o?.user?._id?.toString?.(),
                    o?.user?.email,
                    o?.user?.name,
                    o?.user?.username,
                    o?.profile?.profile_slug,
                    profileSlug,
                    o?.productKey,
                    o?.variant,
                    o?.trackingCode,
                    o?.trackingUrl,
                    o?.deliveryName,
                    o?.customerEmail,
                    customization.frontText,
                    publicProfileUrl,
                    qrTargetUrl,
                    nfcTargetUrl,
                    normalizeFulfillmentStatus(o?.fulfillmentStatus),
                ]
                    .map((x) => cleanString(x, 1200))
                    .join(" ");

                return q.test(haystack);
            });
        }

        return res.json({
            ok: true,
            data: (orders || []).map(serializeOrder),
        });
    } catch (err) {
        console.error("GET /api/admin/orders error:", err);
        return res.status(500).json({ error: "Failed to load orders" });
    }
});

/**
 * PATCH /api/admin/orders/:id/tracking
 */
router.patch("/orders/:id/tracking", async (req, res) => {
    try {
        const orderId = toObjectIdString(req.params.id);
        if (!orderId) {
            return res.status(400).json({ error: "Order id is required" });
        }

        const trackingUrl = cleanString(req.body?.trackingUrl, 1200);
        const trackingCode = cleanString(req.body?.trackingCode, 120);
        const deliveryWindow = cleanString(req.body?.deliveryWindow, 160);
        const notify = !!req.body?.notify;

        const update = {
            trackingUrl,
            trackingCode,
            deliveryWindow,
        };

        if (trackingUrl) {
            update.fulfillmentStatus = "shipped";
        }

        const order = await NfcOrder.findByIdAndUpdate(
            orderId,
            { $set: update },
            { new: true }
        )
            .populate("user", "name email")
            .populate("profile", "profile_slug business_card_name full_name qr_code_url")
            .lean();

        if (!order) {
            return res.status(404).json({ error: "Order not found" });
        }

        if (notify) {
            const email = safeEmail(order?.user?.email);
            if (email) {
                await sendEmail(
                    email,
                    "Your KonarCard order has shipped",
                    buildTrackingEmailHtml({
                        user: order.user,
                        order,
                        trackingUrl,
                        deliveryWindow,
                    })
                );
            }
        }

        return res.json({
            ok: true,
            data: serializeOrder(order),
        });
    } catch (err) {
        console.error("PATCH /api/admin/orders/:id/tracking error:", err);
        return res.status(500).json({ error: "Failed to update tracking" });
    }
});

/**
 * PATCH /api/admin/orders/:id/status
 */
router.patch("/orders/:id/status", async (req, res) => {
    try {
        const orderId = toObjectIdString(req.params.id);
        if (!orderId) {
            return res.status(400).json({ error: "Order id is required" });
        }

        const fulfillmentStatus = normalizeFulfillmentStatus(req.body?.fulfillmentStatus);
        const notify = !!req.body?.notify;

        const order = await NfcOrder.findByIdAndUpdate(
            orderId,
            {
                $set: {
                    fulfillmentStatus,
                },
            },
            { new: true }
        )
            .populate("user", "name email")
            .populate("profile", "profile_slug business_card_name full_name qr_code_url")
            .lean();

        if (!order) {
            return res.status(404).json({ error: "Order not found" });
        }

        if (notify) {
            const email = safeEmail(order?.user?.email);
            if (email) {
                await sendEmail(
                    email,
                    `Your KonarCard order update: ${buildOrderStatusLabel(fulfillmentStatus)}`,
                    buildStatusEmailHtml({
                        user: order.user,
                        status: fulfillmentStatus,
                        trackingUrl: cleanString(order.trackingUrl, 1200),
                    })
                );
            }
        }

        return res.json({
            ok: true,
            data: serializeOrder(order),
        });
    } catch (err) {
        console.error("PATCH /api/admin/orders/:id/status error:", err);
        return res.status(500).json({ error: "Failed to update order status" });
    }
});

module.exports = router;