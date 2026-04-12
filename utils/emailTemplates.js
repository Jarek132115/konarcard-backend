// backend/utils/emailTemplates.js

const escapeHtml = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const safeText = (v) => escapeHtml(String(v || "").trim());

/* ═══════════════════════════════════════════════════════════
   BASE EMAIL LAYOUT
   Dark navy header (#0f172a) · white body · grey footer
   Table-based for max email client compatibility
   ═══════════════════════════════════════════════════════════ */

function baseEmailLayout(bodyContent, { preheader = "" } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta http-equiv="X-UA-Compatible" content="IE=edge"/>
  <title>KonarCard</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,'Helvetica Neue',Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
  ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;">${safeText(preheader)}</div>` : ""}

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;">
    <tr><td align="center" style="padding:32px 16px;">

      <!-- Card -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">

        <!-- Header -->
        <tr>
          <td style="background:#0f172a;padding:28px 32px;text-align:center;">
            <span style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:0.5px;">KonarCard</span>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:36px 32px 28px;color:#1e293b;font-size:15px;line-height:1.65;">
            ${bodyContent}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:20px 32px 28px;border-top:1px solid #f0f0f0;text-align:center;font-size:12px;color:#94a3b8;line-height:1.5;">
            &copy; ${new Date().getFullYear()} KonarCard &middot; All rights reserved<br/>
            <a href="https://konarcard.com" style="color:#94a3b8;text-decoration:underline;">konarcard.com</a>
            &nbsp;&middot;&nbsp;
            <a href="mailto:supportteam@konarcard.com" style="color:#94a3b8;text-decoration:underline;">Support</a>
          </td>
        </tr>

      </table>

    </td></tr>
  </table>
</body>
</html>`;
}

/* ─── Shared helpers ───────────────────────────────────────── */

function btn(href, label, bg = "#f97316") {
  const url = String(href || "#").trim();
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr>
        <td style="background:${bg};border-radius:8px;padding:14px 28px;">
          <a href="${url}" style="color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">${safeText(label)}</a>
        </td>
      </tr>
    </table>`;
}

function heading(text) {
  return `<h2 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#0f172a;">${safeText(text)}</h2>`;
}

function greeting(name) {
  const n = safeText(name) || "there";
  return `<p style="margin:0 0 16px;font-size:15px;">Hi ${n},</p>`;
}

function signoff() {
  return `<p style="margin:24px 0 0;font-size:15px;color:#64748b;">— The KonarCard Team</p>`;
}

function infoRow(label, value) {
  const v = String(value || "").trim();
  if (!v) return "";
  return `
    <tr>
      <td style="padding:10px 12px;border:1px solid #e5e7eb;font-weight:700;background:#f9fafb;width:140px;font-size:14px;">${safeText(label)}</td>
      <td style="padding:10px 12px;border:1px solid #e5e7eb;font-size:14px;">${safeText(v)}</td>
    </tr>`;
}

/* ═══════════════════════════════════════════════════════════
   EMAIL TEMPLATES
   ═══════════════════════════════════════════════════════════ */

// 1 — Verification code (registration / login)
function verificationEmailTemplate(name, code) {
  return baseEmailLayout(`
    ${heading("Verify your email")}
    ${greeting(name)}
    <p style="margin:0 0 16px;">Thanks for signing up! Enter this code to verify your email address:</p>
    <div style="background:#f8fafc;border:2px dashed #e2e8f0;border-radius:10px;padding:20px;text-align:center;margin:0 0 16px;">
      <span style="font-size:32px;font-weight:800;letter-spacing:6px;color:#0f172a;">${safeText(code)}</span>
    </div>
    <p style="margin:0 0 4px;font-size:13px;color:#64748b;">This code expires in <strong>10 minutes</strong>.</p>
    ${signoff()}
  `, { preheader: `Your verification code is ${safeText(code)}` });
}

// 2 — Password reset link
function passwordResetTemplate(name, link) {
  const safeLink = String(link || "").trim();
  return baseEmailLayout(`
    ${heading("Reset your password")}
    ${greeting(name)}
    <p style="margin:0 0 4px;">We received a request to reset your password. Click the button below to choose a new one:</p>
    ${btn(safeLink, "Reset Password", "#0f172a")}
    <p style="margin:0 0 4px;font-size:13px;color:#64748b;">This link expires in <strong>1 hour</strong>. If you didn't request this, you can safely ignore this email.</p>
    ${signoff()}
  `, { preheader: "Reset your KonarCard password" });
}

// 3 — Password reset success
function passwordResetSuccessTemplate(name) {
  return baseEmailLayout(`
    ${heading("Password changed")}
    ${greeting(name)}
    <p style="margin:0 0 16px;">Your password has been successfully changed. You can now log in with your new password.</p>
    <p style="margin:0 0 4px;font-size:13px;color:#64748b;">If you didn't make this change, please contact us immediately at <a href="mailto:supportteam@konarcard.com" style="color:#f97316;">supportteam@konarcard.com</a></p>
    ${signoff()}
  `, { preheader: "Your KonarCard password has been changed" });
}

// 4 — Welcome email (after verification)
function welcomeEmailTemplate(name) {
  return baseEmailLayout(`
    ${heading("Welcome to KonarCard!")}
    ${greeting(name)}
    <p style="margin:0 0 16px;">Your email is verified and your account is ready to go. Here's how to get started:</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;width:100%;">
      <tr>
        <td style="padding:10px 0;font-size:15px;">
          <strong style="color:#f97316;">1.</strong>&nbsp; Claim your unique KonarCard link
        </td>
      </tr>
      <tr>
        <td style="padding:10px 0;font-size:15px;">
          <strong style="color:#f97316;">2.</strong>&nbsp; Add your services, photos, and reviews
        </td>
      </tr>
      <tr>
        <td style="padding:10px 0;font-size:15px;">
          <strong style="color:#f97316;">3.</strong>&nbsp; Share via link, QR code, or NFC card
        </td>
      </tr>
    </table>
    ${btn("https://konarcard.com/login", "Go to Dashboard")}
    <p style="margin:0;font-size:13px;color:#64748b;">Need help? Reply to this email or start a live chat on our website.</p>
    ${signoff()}
  `, { preheader: "Your KonarCard account is ready — let's build your profile" });
}

// 5 — Order confirmation (customer)
function orderConfirmationTemplate(customerName, amountPaid) {
  const amt = safeText(amountPaid);
  const name = safeText(customerName);
  return baseEmailLayout(`
    ${heading("Order confirmed")}
    ${greeting(name || "there")}
    <p style="margin:0 0 16px;">Thank you for your order! Your payment of <strong>&pound;${amt}</strong> has been received.</p>
    <div style="background:#f0fdf4;border-left:4px solid #22c55e;padding:14px 16px;border-radius:6px;margin:0 0 16px;">
      <p style="margin:0;font-size:14px;color:#166534;font-weight:600;">We'll begin preparing your KonarCard right away.</p>
    </div>
    <p style="margin:0 0 4px;font-size:14px;">You can track your order status from your <a href="https://konarcard.com/myorders" style="color:#f97316;font-weight:600;">dashboard</a>.</p>
    ${signoff()}
  `, { preheader: `Order confirmed — £${amt} received` });
}

// 6 — Order notification (admin)
function orderNotificationAdminTemplate(customerName, customerEmail, productKey, variant, quantity, amountPaid) {
  return baseEmailLayout(`
    ${heading("New order received")}
    <p style="margin:0 0 16px;">A new order has been placed on KonarCard.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:500px;margin:0 0 16px;">
      ${infoRow("Customer", customerName)}
      ${infoRow("Email", customerEmail)}
      ${infoRow("Product", productKey)}
      ${infoRow("Variant", variant)}
      ${infoRow("Quantity", quantity)}
      ${infoRow("Amount", amountPaid ? `£${safeText(amountPaid)}` : "—")}
    </table>
    ${btn("https://konarcard.com/admin/orders", "View in Admin", "#0f172a")}
    ${signoff()}
  `, { preheader: `New order from ${safeText(customerName || customerEmail)}` });
}

// 7 — Order shipped
function orderShippedTemplate(name, trackingUrl, deliveryWindow) {
  const tracking = String(trackingUrl || "").trim();
  const delivery = safeText(deliveryWindow);
  return baseEmailLayout(`
    ${heading("Your order has shipped!")}
    ${greeting(name)}
    <p style="margin:0 0 16px;">Great news — your KonarCard order is on its way.</p>
    ${tracking ? btn(tracking, "Track Your Order") : ""}
    ${delivery ? `<p style="margin:0 0 16px;font-size:14px;"><strong>Estimated delivery:</strong> ${delivery}</p>` : ""}
    <p style="margin:0 0 4px;font-size:13px;color:#64748b;">If you have any questions about your delivery, just reply to this email.</p>
    ${signoff()}
  `, { preheader: "Your KonarCard order is on its way" });
}

// 8 — Order status update
function orderStatusUpdateTemplate(name, status, trackingUrl) {
  const tracking = String(trackingUrl || "").trim();
  const statusText = safeText(status);
  return baseEmailLayout(`
    ${heading("Order update")}
    ${greeting(name)}
    <p style="margin:0 0 16px;">Your KonarCard order status has been updated:</p>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;text-align:center;margin:0 0 16px;">
      <span style="font-size:16px;font-weight:700;color:#0f172a;">${statusText}</span>
    </div>
    ${tracking ? btn(tracking, "Track Your Order") : ""}
    <p style="margin:0 0 4px;font-size:14px;">View full order details in your <a href="https://konarcard.com/myorders" style="color:#f97316;font-weight:600;">dashboard</a>.</p>
    ${signoff()}
  `, { preheader: `Order update: ${statusText}` });
}

// 9 — Contact exchange (visitor → profile owner)
function contactExchangeTemplate(ownerName, profileSlug, payload = {}) {
  const owner = safeText(ownerName) || "there";
  const slug = safeText(profileSlug);
  return baseEmailLayout(`
    ${heading("New contact exchange")}
    <p style="margin:0 0 8px;font-size:15px;">Hi ${owner},</p>
    <p style="margin:0 0 16px;">Someone shared their details from your KonarCard profile <strong>${slug}</strong>.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:500px;margin:0 0 16px;">
      ${infoRow("Name", payload.visitor_name)}
      ${infoRow("Email", payload.visitor_email)}
      ${infoRow("Phone", payload.visitor_phone)}
      ${infoRow("Message", payload.message)}
    </table>
    <p style="margin:0 0 4px;font-size:13px;color:#64748b;">Tip: reply directly to this email if you want to continue the conversation.</p>
    ${signoff()}
  `, { preheader: `New contact from ${safeText(payload.visitor_name || "someone")} via your KonarCard` });
}

// 10 — Contact form (visitor → admin)
function contactFormAdminTemplate(senderName, senderEmail, reason, message) {
  return baseEmailLayout(`
    ${heading("New contact form submission")}
    <p style="margin:0 0 16px;">A visitor submitted the contact form on konarcard.com.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:500px;margin:0 0 16px;">
      ${infoRow("Name", senderName)}
      ${infoRow("Email", senderEmail)}
      ${infoRow("Reason", reason)}
      ${infoRow("Message", message)}
    </table>
    <p style="margin:0 0 4px;font-size:13px;color:#64748b;">Reply directly to the sender at <a href="mailto:${safeText(senderEmail)}" style="color:#f97316;">${safeText(senderEmail)}</a></p>
    ${signoff()}
  `, { preheader: `Contact form: ${safeText(reason)}` });
}

// 11 — Subscription started
function subscriptionStartedTemplate(name, plan, interval) {
  const planName = safeText(plan || "Plus");
  const int = safeText(interval || "monthly");
  return baseEmailLayout(`
    ${heading("Subscription activated!")}
    ${greeting(name)}
    <p style="margin:0 0 16px;">You're now on the <strong>${planName}</strong> plan (${int}). Here's what's unlocked:</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;width:100%;">
      <tr><td style="padding:8px 0;font-size:14px;">&#10003;&nbsp; All templates unlocked</td></tr>
      <tr><td style="padding:8px 0;font-size:14px;">&#10003;&nbsp; Up to 12 images, services &amp; reviews</td></tr>
      <tr><td style="padding:8px 0;font-size:14px;">&#10003;&nbsp; Full analytics dashboard</td></tr>
      ${planName.toLowerCase().includes("teams") ? '<tr><td style="padding:8px 0;font-size:14px;">&#10003;&nbsp; Multiple team profiles</td></tr>' : ""}
    </table>
    ${btn("https://konarcard.com/dashboard", "Go to Dashboard")}
    ${signoff()}
  `, { preheader: `You're on the ${planName} plan — all features unlocked` });
}

// 12 — Subscription cancelled
function subscriptionCancelledTemplate(name, endDate) {
  const end = safeText(endDate);
  return baseEmailLayout(`
    ${heading("Subscription cancelled")}
    ${greeting(name)}
    <p style="margin:0 0 16px;">Your subscription has been cancelled. You'll continue to have access to all Plus features until <strong>${end}</strong>.</p>
    <p style="margin:0 0 16px;font-size:14px;">After that, your account will revert to the free plan. Your profile and data will stay safe — you just won't have access to Plus features.</p>
    <p style="margin:0 0 4px;font-size:14px;">Changed your mind? You can resubscribe anytime from your <a href="https://konarcard.com/settings" style="color:#f97316;font-weight:600;">settings</a>.</p>
    ${signoff()}
  `, { preheader: `Your subscription is cancelled — access continues until ${end}` });
}

// 13 — Payment failed
function paymentFailedTemplate(name) {
  return baseEmailLayout(`
    ${heading("Payment failed")}
    ${greeting(name)}
    <p style="margin:0 0 16px;">We weren't able to process your latest subscription payment. Your account has been marked as past due.</p>
    <div style="background:#fef2f2;border-left:4px solid #ef4444;padding:14px 16px;border-radius:6px;margin:0 0 16px;">
      <p style="margin:0;font-size:14px;color:#991b1b;font-weight:600;">Please update your payment method to keep your Plus features active.</p>
    </div>
    ${btn("https://konarcard.com/settings", "Update Payment Method", "#0f172a")}
    <p style="margin:0 0 4px;font-size:13px;color:#64748b;">If you need help, reply to this email or contact us at <a href="mailto:supportteam@konarcard.com" style="color:#f97316;">supportteam@konarcard.com</a></p>
    ${signoff()}
  `, { preheader: "Action needed: your KonarCard payment failed" });
}

// 14 — Payment reminder (day before charge)
function paymentReminderTemplate(name, nextDate) {
  const date = safeText(nextDate);
  return baseEmailLayout(`
    ${heading("Payment reminder")}
    ${greeting(name)}
    <p style="margin:0 0 16px;">Just a heads up — your KonarCard subscription will renew on <strong>${date}</strong>.</p>
    <p style="margin:0 0 16px;font-size:14px;">No action is needed if you'd like to continue. If you want to make any changes to your plan or payment method, you can do so from your settings.</p>
    ${btn("https://konarcard.com/settings", "Manage Subscription")}
    ${signoff()}
  `, { preheader: `Your KonarCard subscription renews on ${date}` });
}

module.exports = {
  verificationEmailTemplate,
  passwordResetTemplate,
  passwordResetSuccessTemplate,
  welcomeEmailTemplate,
  orderConfirmationTemplate,
  orderNotificationAdminTemplate,
  orderShippedTemplate,
  orderStatusUpdateTemplate,
  contactExchangeTemplate,
  contactFormAdminTemplate,
  subscriptionStartedTemplate,
  subscriptionCancelledTemplate,
  paymentFailedTemplate,
  paymentReminderTemplate,
};
