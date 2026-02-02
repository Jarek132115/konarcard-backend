// backend/controllers/businessCardController.js
const BusinessCard = require("../models/BusinessCard");
const uploadToS3 = require("../utils/uploadToS3");

const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * ---------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------
 */

const safeSlug = (v) =>
  String(v || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, ""); // keep only a-z 0-9 hyphen (match schema intent)

const parseJsonArray = (v, fallback = []) => {
  try {
    if (v == null) return fallback;
    if (Array.isArray(v)) return v;
    if (typeof v === "string") return JSON.parse(v);
    return fallback;
  } catch {
    return fallback;
  }
};

const asBool = (v, defaultVal = true) => {
  if (v === undefined || v === null || v === "") return defaultVal;
  const s = String(v).toLowerCase();
  if (s === "0" || s === "false") return false;
  if (s === "1" || s === "true") return true;
  return defaultVal;
};

const getPlanFromReq = (req) => {
  const plan = String(req.user?.plan || "free").toLowerCase();
  if (plan === "plus" || plan === "teams") return plan;
  return "free";
};

const FREE_LIMIT = 6;

const isTemplateAllowed = (plan, templateId) => {
  const t = String(templateId || "template-1");
  const allowed = new Set(["template-1", "template-2", "template-3", "template-4", "template-5"]);
  if (!allowed.has(t)) return false;
  if (plan === "free") return t === "template-1";
  return true; // plus / teams
};

const maxProfilesForPlan = (plan) => {
  if (plan === "teams") return Infinity;
  // per your requirement: free and plus can have 1 profile only
  return 1;
};

const upgradeRequired = (res, payload = {}) => {
  return res.status(403).json({
    code: "UPGRADE_REQUIRED",
    ...payload,
  });
};

/**
 * Enforce Free limits (works/services/reviews)
 */
const enforceFreeContentLimits = ({ plan, works, services, reviews }) => {
  if (plan !== "free") return null;

  if ((works?.length || 0) > FREE_LIMIT) {
    return { field: "works", limit: FREE_LIMIT, current: works.length };
  }
  if ((services?.length || 0) > FREE_LIMIT) {
    return { field: "services", limit: FREE_LIMIT, current: services.length };
  }
  if ((reviews?.length || 0) > FREE_LIMIT) {
    return { field: "reviews", limit: FREE_LIMIT, current: reviews.length };
  }
  return null;
};

/**
 * ---------------------------------------------------------
 * Teams billing helpers
 * ---------------------------------------------------------
 */

const TEAMS_PRICE_IDS = [
  process.env.STRIPE_PRICE_TEAMS_MONTHLY,
  process.env.STRIPE_PRICE_TEAMS_QUARTERLY,
  process.env.STRIPE_PRICE_TEAMS_YEARLY,
].filter(Boolean);

/**
 * Update Stripe Teams subscription quantity to match profile count (prorated).
 * We only do this if:
 * - plan === "teams"
 * - user has stripeSubscriptionId
 * - we can find the Teams subscription item in Stripe
 */
const syncTeamsQuantityToStripe = async ({ user, desiredQuantity }) => {
  if (!user) throw new Error("Missing user");
  if (String(user.plan || "").toLowerCase() !== "teams") return { skipped: true, reason: "not_teams" };
  if (!user.stripeSubscriptionId) throw new Error("Missing stripeSubscriptionId for Teams user");
  if (!TEAMS_PRICE_IDS.length) throw new Error("Teams price IDs not configured in env");

  const qty = Math.max(1, Number(desiredQuantity || 1));

  // Retrieve subscription with expanded items to locate teams base price item
  const sub = await stripe.subscriptions.retrieve(user.stripeSubscriptionId, {
    expand: ["items.data.price"],
  });

  const items = Array.isArray(sub?.items?.data) ? sub.items.data : [];
  const teamsItem = items.find((it) => {
    const priceId = it?.price?.id;
    return priceId && TEAMS_PRICE_IDS.includes(priceId);
  });

  if (!teamsItem?.id) {
    throw new Error("Could not find Teams subscription item on Stripe subscription");
  }

  // Update the subscription item quantity with proration
  await stripe.subscriptionItems.update(teamsItem.id, {
    quantity: qty,
    proration_behavior: "create_prorations",
  });

  return { skipped: false, quantity: qty };
};

/**
 * ---------------------------------------------------------
 * PROTECTED (requireAuth)
 * ---------------------------------------------------------
 */

// (COMPAT STUB) GET /api/business-card/me
// Your new system has NO default profile; frontend should use /profiles and select one.
const getMyBusinessCard = async (req, res) => {
  return res.status(400).json({
    error: "No default profile. Use GET /api/business-card/profiles and pick a profile_slug.",
    code: "NO_DEFAULT_PROFILE",
  });
};

// GET /api/business-card/profiles
const getMyProfiles = async (req, res) => {
  try {
    if (!req.user?._id) return res.status(401).json({ error: "Unauthorized" });

    const cards = await BusinessCard.find({ user: req.user._id }).sort({ updatedAt: -1 });
    return res.json({ data: cards || [] });
  } catch (err) {
    console.error("getMyProfiles:", err);
    return res.status(500).json({ error: "Failed to fetch profiles" });
  }
};

// GET /api/business-card/profiles/:slug
const getMyProfileBySlug = async (req, res) => {
  try {
    if (!req.user?._id) return res.status(401).json({ error: "Unauthorized" });

    const slug = safeSlug(req.params.slug);
    if (!slug) return res.status(400).json({ error: "profile_slug required" });

    const card = await BusinessCard.findOne({ user: req.user._id, profile_slug: slug });
    return res.json({ data: card || null });
  } catch (err) {
    console.error("getMyProfileBySlug:", err);
    return res.status(500).json({ error: "Failed to fetch profile" });
  }
};

// POST /api/business-card/profiles  (create profile)
const createMyProfile = async (req, res) => {
  let created = null;

  try {
    if (!req.user?._id) return res.status(401).json({ error: "Unauthorized" });

    const plan = getPlanFromReq(req);
    const userId = req.user._id;

    const slug = safeSlug(req.body.profile_slug);
    if (!slug || slug.length < 3) {
      return res.status(400).json({ error: "profile_slug must be at least 3 characters" });
    }

    // Plan gate: max profiles
    const count = await BusinessCard.countDocuments({ user: userId });
    const maxAllowed = maxProfilesForPlan(plan);

    if (count >= maxAllowed) {
      return upgradeRequired(res, {
        reason: "PROFILE_LIMIT",
        plan,
        maxProfiles: maxAllowed,
        currentProfiles: count,
      });
    }

    // GLOBAL slug uniqueness (critical for /u/:slug)
    const slugTaken = await BusinessCard.findOne({ profile_slug: slug }).select("_id");
    if (slugTaken) {
      return res.status(409).json({ error: "Profile slug already exists" });
    }

    const templateId = req.body.template_id || "template-1";
    if (!isTemplateAllowed(plan, templateId)) {
      return upgradeRequired(res, {
        reason: "TEMPLATE_LOCKED",
        plan,
        allowedTemplates:
          plan === "free"
            ? ["template-1"]
            : ["template-1", "template-2", "template-3", "template-4", "template-5"],
      });
    }

    created = await BusinessCard.create({
      user: userId,
      profile_slug: slug,
      template_id: templateId,
      business_card_name: req.body.business_card_name || "",
    });

    // ✅ Teams billing: update quantity to new count (prorated)
    if (plan === "teams") {
      const newCount = await BusinessCard.countDocuments({ user: userId });
      try {
        await syncTeamsQuantityToStripe({ user: req.user, desiredQuantity: newCount });
      } catch (e) {
        // Rollback DB change so billing never drifts
        try {
          await BusinessCard.deleteOne({ _id: created._id });
        } catch { }
        return res.status(500).json({
          error: "Profile created but billing sync failed. No changes were saved.",
          code: "TEAMS_BILLING_SYNC_FAILED",
        });
      }
    }

    return res.status(201).json({ data: created });
  } catch (err) {
    console.error("createMyProfile:", err);
    // safety rollback if partially created
    if (created?._id) {
      try {
        await BusinessCard.deleteOne({ _id: created._id });
      } catch { }
    }
    return res.status(500).json({ error: "Failed to create profile" });
  }
};

// (COMPAT STUB) PATCH /api/business-card/profiles/:slug/default
// Not supported anymore. No default profile concept.
const setDefaultProfile = async (req, res) => {
  return res.status(400).json({
    error: "Default profile is not supported. Profiles are independent. Pick by profile_slug.",
    code: "NO_DEFAULT_PROFILE",
  });
};

// DELETE /api/business-card/profiles/:slug
const deleteMyProfile = async (req, res) => {
  let removedDoc = null;

  try {
    if (!req.user?._id) return res.status(401).json({ error: "Unauthorized" });

    const plan = getPlanFromReq(req);
    const userId = req.user._id;

    const slug = safeSlug(req.params.slug);
    if (!slug) return res.status(400).json({ error: "profile_slug required" });

    const card = await BusinessCard.findOne({ user: userId, profile_slug: slug });
    if (!card) return res.status(404).json({ error: "Profile not found" });

    removedDoc = card.toObject();

    await BusinessCard.deleteOne({ _id: card._id });

    // ✅ Teams billing: update quantity to new count (prorated)
    if (plan === "teams") {
      const newCount = await BusinessCard.countDocuments({ user: userId });
      try {
        await syncTeamsQuantityToStripe({ user: req.user, desiredQuantity: newCount });
      } catch (e) {
        // rollback delete so billing doesn’t drift
        try {
          await BusinessCard.create(removedDoc);
        } catch { }
        return res.status(500).json({
          error: "Profile deletion failed because billing sync failed. No changes were saved.",
          code: "TEAMS_BILLING_SYNC_FAILED",
        });
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("deleteMyProfile:", err);
    // attempt rollback if needed
    if (removedDoc && removedDoc._id) {
      try {
        const exists = await BusinessCard.findById(removedDoc._id).select("_id");
        if (!exists) await BusinessCard.create(removedDoc);
      } catch { }
    }
    return res.status(500).json({ error: "Failed to delete profile" });
  }
};

// POST /api/business-card  (upsert save, supports profile_slug)
const saveBusinessCard = async (req, res) => {
  try {
    if (!req.user?._id) return res.status(401).json({ error: "Unauthorized" });

    const plan = getPlanFromReq(req);
    const userId = req.user._id;

    const profile_slug = safeSlug(req.body.profile_slug);
    if (!profile_slug || profile_slug.length < 3) {
      return res.status(400).json({ error: "profile_slug is required and must be at least 3 chars" });
    }

    // GLOBAL slug protection: if someone else owns this slug, block save
    const otherOwner = await BusinessCard.findOne({
      profile_slug,
      user: { $ne: userId },
    }).select("_id");
    if (otherOwner) {
      return res.status(409).json({ error: "Profile slug already exists" });
    }

    // Arrays from FormData
    const services = parseJsonArray(req.body.services, []);
    const reviews = parseJsonArray(req.body.reviews, []);

    // existing_works can come as repeated fields
    const existing_works = []
      .concat(req.body.existing_works || [])
      .flat()
      .filter(Boolean);

    // Upload cover/avatar if provided
    let cover_photo_url = null;
    let avatar_url = null;

    if (req.files?.cover_photo?.[0]) {
      const f = req.files.cover_photo[0];
      const key = `cover_photos/${userId}/${Date.now()}-${f.originalname}`;
      cover_photo_url = await uploadToS3(f.buffer, key);
    }

    if (req.files?.avatar?.[0]) {
      const f = req.files.avatar[0];
      const key = `avatars/${userId}/${Date.now()}-${f.originalname}`;
      avatar_url = await uploadToS3(f.buffer, key);
    }

    // Upload new work images
    const uploadedWorkUrls = [];
    const workFiles = req.files?.works || [];
    for (const f of workFiles) {
      const key = `works/${userId}/${Date.now()}-${Math.random().toString(16).slice(2)}-${f.originalname}`;
      const url = await uploadToS3(f.buffer, key);
      if (url) uploadedWorkUrls.push(url);
    }

    const works = [...existing_works, ...uploadedWorkUrls];

    // Plan enforcement: free limits for works/services/reviews
    const limitHit = enforceFreeContentLimits({ plan, works, services, reviews });
    if (limitHit) {
      return upgradeRequired(res, {
        reason: "SECTION_LIMIT",
        plan,
        ...limitHit,
      });
    }

    // Template gating
    const requestedTemplate = req.body.template_id || "template-1";
    if (!isTemplateAllowed(plan, requestedTemplate)) {
      return upgradeRequired(res, {
        reason: "TEMPLATE_LOCKED",
        plan,
        allowedTemplates:
          plan === "free"
            ? ["template-1"]
            : ["template-1", "template-2", "template-3", "template-4", "template-5"],
      });
    }

    // If there is no existing card with this slug, we are creating it on upsert.
    const existingCard = await BusinessCard.findOne({ user: userId, profile_slug }).select("_id");
    if (!existingCard) {
      const count = await BusinessCard.countDocuments({ user: userId });
      const maxAllowed = maxProfilesForPlan(plan);
      if (count >= maxAllowed) {
        return upgradeRequired(res, {
          reason: "PROFILE_LIMIT",
          plan,
          maxProfiles: maxAllowed,
          currentProfiles: count,
        });
      }
    }

    const update = {
      user: userId,
      profile_slug,

      template_id: requestedTemplate,

      business_card_name: req.body.business_card_name || "",
      page_theme: req.body.page_theme || "light",
      page_theme_variant: req.body.page_theme_variant || "subtle-light",
      style: req.body.style || "Inter",
      main_heading: req.body.main_heading || "",
      sub_heading: req.body.sub_heading || "",
      full_name: req.body.full_name || "",
      bio: req.body.bio || "",
      job_title: req.body.job_title || "",

      contact_email: req.body.contact_email || "",
      phone_number: req.body.phone_number || "",

      services,
      reviews,

      work_display_mode: req.body.work_display_mode || "list",
      services_display_mode: req.body.services_display_mode || "list",
      reviews_display_mode: req.body.reviews_display_mode || "list",
      about_me_layout: req.body.about_me_layout || "side-by-side",

      show_main_section: asBool(req.body.show_main_section, true),
      show_about_me_section: asBool(req.body.show_about_me_section, true),
      show_work_section: asBool(req.body.show_work_section, true),
      show_services_section: asBool(req.body.show_services_section, true),
      show_reviews_section: asBool(req.body.show_reviews_section, true),
      show_contact_section: asBool(req.body.show_contact_section, true),

      button_bg_color: req.body.button_bg_color || "#F47629",
      button_text_color: req.body.button_text_color || "white",
      text_alignment: req.body.text_alignment || "left",

      facebook_url: req.body.facebook_url || "",
      instagram_url: req.body.instagram_url || "",
      linkedin_url: req.body.linkedin_url || "",
      x_url: req.body.x_url || "",
      tiktok_url: req.body.tiktok_url || "",

      section_order: parseJsonArray(req.body.section_order, ["main", "about", "work", "services", "reviews", "contact"]),

      works,
    };

    // Handle removals
    const coverRemoved = asBool(req.body.cover_photo_removed, false);
    const avatarRemoved = asBool(req.body.avatar_removed, false);

    if (coverRemoved) update.cover_photo = "";
    if (avatarRemoved) update.avatar = "";

    if (cover_photo_url) update.cover_photo = cover_photo_url;
    if (avatar_url) update.avatar = avatar_url;

    const saved = await BusinessCard.findOneAndUpdate(
      { user: userId, profile_slug },
      { $set: update },
      { new: true, upsert: true }
    );

    return res.json({ data: saved });
  } catch (err) {
    console.error("saveBusinessCard:", err);
    return res.status(500).json({ error: "Failed to save business card" });
  }
};

/**
 * ---------------------------------------------------------
 * PUBLIC
 * ---------------------------------------------------------
 */

// NEW: GET /api/business-card/public/:slug
// This matches www.konarcard.com/u/:slug requirement (GLOBAL slug)
const getPublicBySlug = async (req, res) => {
  try {
    const slug = safeSlug(req.params.slug);
    if (!slug) return res.status(400).json({ error: "slug required" });

    const card = await BusinessCard.findOne({ profile_slug: slug });
    if (!card) return res.status(404).json({ error: "Business card not found" });

    return res.json(card);
  } catch (err) {
    console.error("getPublicBySlug:", err);
    return res.status(500).json({ error: "Failed to fetch business card" });
  }
};

// (COMPAT STUBS) Old username-based endpoints (not used in new /u/:slug system)
const getPublicByUsername = async (req, res) => {
  return res.status(400).json({
    error: "Username-based public profiles are deprecated. Use GET /api/business-card/public/:slug",
    code: "DEPRECATED",
  });
};

const getPublicByUsernameAndSlug = async (req, res) => {
  return res.status(400).json({
    error: "Username-based public profiles are deprecated. Use GET /api/business-card/public/:slug",
    code: "DEPRECATED",
  });
};

module.exports = {
  // protected
  getMyBusinessCard,
  saveBusinessCard,

  getMyProfiles,
  getMyProfileBySlug,
  createMyProfile,
  setDefaultProfile,
  deleteMyProfile,

  // public
  getPublicBySlug,
  getPublicByUsername,
  getPublicByUsernameAndSlug,
};
