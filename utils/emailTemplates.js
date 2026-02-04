// backend/utils/emailTemplates.js

const escapeHtml = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const safeText = (v) => escapeHtml(String(v || "").trim());

function verificationEmailTemplate(name, code) {
  return `
    <div style="font-family: Arial, sans-serif; padding: 20px;">
      <h2>Hi ${safeText(name)},</h2>
      <p>Thanks for signing up! Please verify your email using the code below:</p>
      <div style="font-size: 24px; font-weight: bold; margin: 20px 0;">${safeText(code)}</div>
      <p>This code will expire in 10 minutes.</p>
      <br/>
      <p>— KonarCard Team</p>
      <img src="https://konarcard.com/assets/banner.png" alt="KonarCard" style="width: 100%; max-width: 500px;" />
    </div>
  `;
}

function passwordResetTemplate(name, link) {
  const safeLink = String(link || "").trim(); // keep URL intact
  return `
    <div style="font-family: Arial, sans-serif; padding: 20px;">
      <h2>Hi ${safeText(name)},</h2>
      <p>You requested to reset your password. Click the link below to choose a new one:</p>
      <a href="${safeLink}" style="font-size: 18px; font-weight: bold; display: inline-block; margin: 20px 0; color: #007BFF;">Reset Password</a>
      <p>If you didn’t request this, you can ignore this email.</p>
      <br/>
      <p>— KonarCard Team</p>
      <img src="https://konarcard.com/assets/banner.png" alt="KonarCard" style="width: 100%; max-width: 500px;" />
    </div>
  `;
}

function orderConfirmationTemplate(customerEmail, amountPaid) {
  // amountPaid may come as number/string; display safely
  const amt = safeText(amountPaid);
  const email = safeText(customerEmail);

  return `
    <div style="font-family: Arial, sans-serif; padding: 20px;">
      <h2>Order Confirmation</h2>
      <p>Hi${email ? ` ${email}` : ""},</p>
      <p>Thank you for your order. Your payment of <strong>£${amt}</strong> has been received.</p>
      <p>We'll begin preparing your Konar Card right away.</p>
      <br />
      <p>— KonarCard Team</p>
      <img src="https://konarcard.com/assets/banner.png" alt="KonarCard" style="width: 100%; max-width: 500px;" />
    </div>
  `;
}

/**
 * ✅ NEW: Contact Exchange email (visitor -> profile owner)
 * Used by POST /exchange-contact
 */
function contactExchangeTemplate(ownerName, profileSlug, payload = {}) {
  const row = (label, val) => {
    const v = String(val || "").trim();
    if (!v) return "";
    return `
      <tr>
        <td style="padding: 10px 12px; border: 1px solid #e5e7eb; font-weight: 700; background: #f9fafb; width: 140px;">
          ${safeText(label)}
        </td>
        <td style="padding: 10px 12px; border: 1px solid #e5e7eb;">
          ${safeText(v)}
        </td>
      </tr>
    `;
  };

  const owner = safeText(ownerName) || "there";
  const slug = safeText(profileSlug);

  return `
    <div style="font-family: Arial, sans-serif; padding: 20px; color: #111;">
      <h2 style="margin: 0 0 10px;">New contact exchange</h2>
      <p style="margin: 0 0 10px;">Hi ${owner},</p>
      <p style="margin: 0 0 14px;">Someone shared their details from your KonarCard profile.</p>

      <p style="margin: 0 0 14px;">
        <strong>Profile:</strong> ${slug}
      </p>

      <table style="border-collapse: collapse; width: 100%; max-width: 640px;">
        ${row("Name", payload.visitor_name)}
        ${row("Email", payload.visitor_email)}
        ${row("Phone", payload.visitor_phone)}
        ${row("Message", payload.message)}
      </table>

      <p style="margin-top: 16px; opacity: 0.85;">
        Tip: reply directly to this email if you want to continue the conversation.
      </p>

      <br/>
      <p>— KonarCard Team</p>
      <img src="https://konarcard.com/assets/banner.png" alt="KonarCard" style="width: 100%; max-width: 500px;" />
    </div>
  `;
}

module.exports = {
  verificationEmailTemplate,
  passwordResetTemplate,
  orderConfirmationTemplate,
  contactExchangeTemplate,
};
