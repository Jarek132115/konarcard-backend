function verificationEmailTemplate(name, code) {
  return `
    <div style="font-family: Arial, sans-serif; padding: 20px;">
      <h2>Hi ${name},</h2>
      <p>Thanks for signing up! Please verify your email using the code below:</p>
      <div style="font-size: 24px; font-weight: bold; margin: 20px 0;">${code}</div>
      <p>This code will expire in 10 minutes.</p>
      <br/>
      <p>— KonarCard Team</p>
      <img src="https://konarcard.com/assets/banner.png" alt="KonarCard" style="width: 100%; max-width: 500px;" />
    </div>
  `;
}

function passwordResetTemplate(name, link) {
  return `
    <div style="font-family: Arial, sans-serif; padding: 20px;">
      <h2>Hi ${name},</h2>
      <p>You requested to reset your password. Click the link below to choose a new one:</p>
      <a href="${link}" style="font-size: 18px; font-weight: bold; display: inline-block; margin: 20px 0; color: #007BFF;">Reset Password</a>
      <p>If you didn’t request this, you can ignore this email.</p>
      <br/>
      <p>— KonarCard Team</p>
      <img src="https://konarcard.com/assets/banner.png" alt="KonarCard" style="width: 100%; max-width: 500px;" />
    </div>
  `;
}

function orderConfirmationTemplate(customerEmail, amountPaid) {
  return `
    <div style="font-family: Arial, sans-serif; padding: 20px;">
      <h2>Order Confirmation</h2>
      <p>Hi,</p>
      <p>Thank you for your order. Your payment of <strong>£${amountPaid}</strong> has been received.</p>
      <p>We'll begin preparing your Konar Card right away.</p>
      <br />
      <p>— KonarCard Team</p>
      <img src="https://konarcard.com/assets/banner.png" alt="KonarCard" style="width: 100%; max-width: 500px;" />
    </div>
  `;
}

module.exports = {
  verificationEmailTemplate,
  passwordResetTemplate,
  orderConfirmationTemplate,
};
