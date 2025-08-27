// utils/emailTemplates.js

// ----- Brand settings (edit once) -------------------------------------------
const BRAND = {
  name: "KonarCard",
  primary: "#007bff",               // CTA / links
  dark: "#0b0c0f",                  // Header background
  lightText: "#ffffff",             // Header text
  bodyBg: "#f4f6f8",
  cardBg: "#ffffff",
  text: "#222222",
  muted: "#6b7280",
  border: "#e5e7eb",
  logoUrl: "https://konarcard.com/assets/logo.png",
  bannerUrl: "https://konarcard.com/assets/banner.png", // optional hero image
  siteUrl: process.env.CLIENT_URL || "https://www.konarcard.com",
  supportEmail: "supportteam@konarcard.com",
  address: "KonarCard • London, UK",
};

// Re-usable button HTML (inline styles for email clients)
function button(label, url, bg = BRAND.primary) {
  return `
    <table cellpadding="0" cellspacing="0" border="0" align="center" style="margin: 22px auto 6px;">
      <tr>
        <td bgcolor="${bg}" style="border-radius:10px;">
          <a href="${url}"
             style="display:inline-block; padding:12px 22px; font-weight:700; font-size:15px; color:#fff; text-decoration:none; white-space:nowrap;">
            ${label}
          </a>
        </td>
      </tr>
    </table>
  `;
}

// The base email frame – table layout + inline CSS for max compatibility
function renderEmail({ title, preheader = "", headline = "", bodyHtml = "", ctaHtml = "", footerNote = "", heroUrl = BRAND.bannerUrl }) {
  // Preheader is hidden preview text in inbox
  const preheaderHtml = `
    <div style="display:none; opacity:0; visibility:hidden; mso-hide:all; height:0; width:0; overflow:hidden;">
      ${preheader}
    </div>
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title || BRAND.name}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0; padding:0; background:${BRAND.bodyBg}; font-family: Arial, Helvetica, sans-serif; color:${BRAND.text};">

  ${preheaderHtml}

  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="${BRAND.bodyBg}">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <!-- Card -->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background:${BRAND.cardBg}; border-radius:12px; overflow:hidden; box-shadow:0 6px 24px rgba(0,0,0,.08);">

          <!-- Header -->
          <tr>
            <td align="center" bgcolor="${BRAND.dark}" style="padding:26px 26px;">
              <img src="${BRAND.logoUrl}" alt="${BRAND.name}" width="120" style="display:block; margin:0 auto 10px; max-width:140px;">
              <div style="font-weight:800; color:${BRAND.lightText}; font-size:18px; letter-spacing:.2px;">${BRAND.name}</div>
            </td>
          </tr>

          <!-- Hero (optional) -->
          ${heroUrl ? `
            <tr>
              <td align="center" style="padding:0;">
                <img src="${heroUrl}" alt="" width="600" style="display:block; width:100%; max-width:600px;">
              </td>
            </tr>` : ""}

          <!-- Content -->
          <tr>
            <td style="padding:28px 28px 8px;">
              ${headline ? `<h1 style="font-size:20px; line-height:1.4; margin:0 0 8px; color:#111;">${headline}</h1>` : ""}
              <div style="font-size:15px; line-height:1.7; color:${BRAND.text};">
                ${bodyHtml}
              </div>
              ${ctaHtml}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:18px 28px 28px;">
              <div style="font-size:12px; color:${BRAND.muted}; line-height:1.6; border-top:1px solid ${BRAND.border}; padding-top:16px;">
                ${footerNote || `Need help? <a href="mailto:${BRAND.supportEmail}" style="color:${BRAND.primary}; text-decoration:none;">${BRAND.supportEmail}</a>`}
                <br><br>
                <span style="color:${BRAND.muted};">${BRAND.address}</span><br>
                <a href="${BRAND.siteUrl}" style="color:${BRAND.primary}; text-decoration:none;">${BRAND.siteUrl}</a>
                <br><br>
                <a href="${BRAND.siteUrl}/unsubscribe" style="color:${BRAND.muted}; text-decoration:underline;">Unsubscribe</a>
              </div>
            </td>
          </tr>

        </table>
        <!-- /Card -->
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// INDIVIDUAL TEMPLATES
// ---------------------------------------------------------------------------

function verificationEmailTemplate(name, code) {
  const headline = `Verify your email`;
  const bodyHtml = `
    <p style="margin:0 0 14px;">Hi ${name || "there"},</p>
    <p style="margin:0 0 16px;">
      Thanks for signing up to <strong>${BRAND.name}</strong>! Enter this code to verify your email:
    </p>
    <div style="font-weight:800; font-size:28px; letter-spacing:4px; text-align:center; padding:14px 0; margin:16px 0; border:1px dashed ${BRAND.border}; border-radius:10px;">
      ${code}
    </div>
    <p style="margin:0;">This code expires in <strong>10 minutes</strong>.</p>
  `;
  const ctaHtml = button("Open KonarCard", `${BRAND.siteUrl}/login`);
  const preheader = "Your KonarCard verification code is inside.";

  return renderEmail({
    title: "Verify your email",
    preheader,
    headline,
    bodyHtml,
    ctaHtml,
  });
}

function passwordResetTemplate(name, link) {
  const headline = `Reset your password`;
  const bodyHtml = `
    <p style="margin:0 0 14px;">Hi ${name || "there"},</p>
    <p style="margin:0 0 10px;">We received a request to reset your password.</p>
    <p style="margin:0 0 16px;">Click the button below to choose a new one. If you didn't request this, you can safely ignore this message.</p>
  `;
  const ctaHtml = button("Reset Password", link);
  const preheader = "Reset your KonarCard password.";

  return renderEmail({
    title: "Reset your password",
    preheader,
    headline,
    bodyHtml,
    ctaHtml,
  });
}

function orderConfirmationTemplate(customerEmail, amountPaid) {
  const headline = "Order confirmed – thank you!";
  const bodyHtml = `
    <p style="margin:0 0 14px;">Hi ${customerEmail || "there"},</p>
    <p style="margin:0 0 10px;">We’ve received your payment of <strong>£${amountPaid}</strong>.</p>
    <p style="margin:0 0 16px;">We’ll begin preparing your KonarCard right away. You’ll receive updates by email.</p>
  `;
  const ctaHtml = button("View your account", `${BRAND.siteUrl}/myprofile`);
  const preheader = "Your KonarCard order has been confirmed.";

  return renderEmail({
    title: "Order Confirmation",
    preheader,
    headline,
    bodyHtml,
    ctaHtml,
  });
}

function subscriptionConfirmationTemplate(name, amountPaid, eventType) {
  let headline = "";
  let bodyHtml = "";

  switch (eventType) {
    case "subscription_started":
      headline = "Your Konar Premium trial has started!";
      bodyHtml = `
        <p style="margin:0 0 14px;">Hi ${name || "there"},</p>
        <p style="margin:0 0 10px;">Welcome to <strong>Konar Premium</strong> – your 14-day free trial is live.</p>
        <p style="margin:0 0 16px;">You’ve unlocked all profile editing features. After your trial, you'll be billed <strong>£${amountPaid}/month</strong>.</p>
      `;
      break;

    case "subscription_cancelled":
      headline = "Subscription cancellation confirmed";
      bodyHtml = `
        <p style="margin:0 0 14px;">Hi ${name || "there"},</p>
        <p style="margin:0 0 10px;">Your Konar Premium subscription has been cancelled.</p>
        <p style="margin:0 0 16px;">You’ll keep access until the end of your current billing period. We’re sad to see you go.</p>
      `;
      break;

    case "subscription_paid":
      headline = "Payment received – Konar Premium";
      bodyHtml = `
        <p style="margin:0 0 14px;">Hi ${name || "there"},</p>
        <p style="margin:0 0 10px;">Thanks! We’ve processed your payment of <strong>£${amountPaid}</strong>.</p>
        <p style="margin:0 0 16px;">Your subscription remains active with full access.</p>
      `;
      break;

    case "subscription_general":
    default:
      headline = "Your Konar Premium subscription is active";
      bodyHtml = `
        <p style="margin:0 0 14px;">Hi ${name || "there"},</p>
        <p style="margin:0 0 10px;">Thanks for subscribing to <strong>Konar Premium</strong>!</p>
        <p style="margin:0 0 16px;">You now have full access to all features. Your monthly charge is <strong>£${amountPaid}</strong>.</p>
      `;
      break;
  }

  const ctaHtml = button("Go to My Profile", `${BRAND.siteUrl}/myprofile`);
  const preheader = "Konar Premium subscription update.";

  return renderEmail({
    title: headline,
    preheader,
    headline,
    bodyHtml,
    ctaHtml,
  });
}

// ----- Trial reminders ------------------------------------------------------

function trialFirstReminderTemplate(name) {
  const headline = "Your free trial is ending soon";
  const bodyHtml = `
    <p style="margin:0 0 14px;">Hi ${name || "there"},</p>
    <p style="margin:0 0 10px;">Just a quick reminder that your <strong>14-day free trial</strong> is nearly over.</p>
    <p style="margin:0 0 16px;">Keep your digital business card live and editable by upgrading now.</p>
  `;
  const ctaHtml = button("Upgrade to Premium", `${BRAND.siteUrl}/subscription`);
  const preheader = "Don’t lose access to your card.";

  return renderEmail({
    title: "Trial ending soon",
    preheader,
    headline,
    bodyHtml,
    ctaHtml,
  });
}

function trialFinalWarningTemplate(name) {
  const headline = "Last chance – your trial ends today";
  const bodyHtml = `
    <p style="margin:0 0 14px;">Hi ${name || "there"},</p>
    <p style="margin:0 0 10px;">This is your final reminder: your free trial ends very soon.</p>
    <p style="margin:0 0 16px;">If you don’t subscribe, your public profile will be hidden.</p>
  `;
  const ctaHtml = button("Subscribe and keep my card", `${BRAND.siteUrl}/subscription`, "#dc3545");
  const preheader = "Final reminder to keep your card live.";

  return renderEmail({
    title: "Final trial reminder",
    preheader,
    headline,
    bodyHtml,
    ctaHtml,
  });
}

module.exports = {
  verificationEmailTemplate,
  passwordResetTemplate,
  orderConfirmationTemplate,
  subscriptionConfirmationTemplate,
  trialFirstReminderTemplate,
  trialFinalWarningTemplate,
};
