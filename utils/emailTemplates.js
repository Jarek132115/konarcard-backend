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

function subscriptionConfirmationTemplate(name, amountPaid, eventType) {
  let subjectLine = '';
  let bodyContent = '';

  switch (eventType) {
    case 'subscription_started':
      subjectLine = 'Your Konar Premium Subscription Has Started!';
      bodyContent = `
        <p>Hi ${name || ''},</p>
        <p>Welcome to Konar Premium! Your 14-day free trial has begun.</p>
        <p>You now have full access to all profile editing features.</p>
        <p>You'll be charged £${amountPaid} per month after your trial ends.</p>
        <p>Enjoy building your amazing digital profile!</p>
      `;
      break;
    case 'subscription_cancelled':
      subjectLine = 'Your Konar Premium Subscription Cancellation Confirmed';
      bodyContent = `
        <p>Hi ${name || ''},</p>
        <p>Your Konar Premium subscription has been successfully cancelled. You will continue to have access until the end of your current billing period.</p>
        <p>We're sad to see you go! If you change your mind, you can resubscribe anytime.</p>
      `;
      break;
    case 'subscription_paid':
      subjectLine = 'Konar Premium: Payment Received!';
      bodyContent = `
        <p>Hi ${name || ''},</p>
        <p>Thank you! Your payment of <strong>£${amountPaid}</strong> for Konar Premium has been successfully processed.</p>
        <p>Your subscription remains active, and you continue to have full access to all features.</p>
      `;
      break;
    case 'subscription_general':
    default:
      subjectLine = 'Your Konar Premium Subscription is Active!';
      bodyContent = `
        <p>Hi ${name || ''},</p>
        <p>Thank you for subscribing to Konar Premium! Your subscription is now active.</p>
        <p>You now have full access to all profile editing features. Your first charge of £${amountPaid} (after any trial period) will appear on your statement.</p>
        <p>Enjoy building your amazing digital profile!</p>
      `;
      break;
  }

  return `
    <div style="font-family: Arial, sans-serif; padding: 20px;">
      <h2>${subjectLine}</h2>
      ${bodyContent}
      <br />
      <p>— KonarCard Team</p>
      <img src="https://konarcard.com/assets/banner.png" alt="KonarCard" style="width: 100%; max-width: 500px;" />
    </div>
  `;
}

// NEW FUNCTION: trialEndingTemplate
function trialEndingTemplate(name, type) {
  let subject = '';
  let body = '';

  if (type === 'first_reminder') {
    subject = 'Your Free Trial is About to End';
    body = `
            <p>Hi ${name},</p>
            <p>Just a friendly reminder that your **5-minute free trial** is about to expire!</p>
            <p>To continue using your professional digital business card and keep your profile live, please upgrade to a premium subscription.</p>
            <p>Don't let your card go offline. We look forward to having you as a subscriber!</p>
            <p><a href="${process.env.CLIENT_URL}/subscription">Click here to subscribe now!</a></p>
        `;
  } else if (type === 'final_warning') {
    subject = 'Last Chance! Your Trial Ends in Seconds';
    body = `
            <p>Hi ${name},</p>
            <p>This is your final warning. Your 5-minute free trial is ending in just a few moments.</p>
            <p>If you don't subscribe, your public profile will be hidden and your card will no longer be active.</p>
            <p><a href="${process.env.CLIENT_URL}/subscription">Click here to subscribe and save your card!</a></p>
        `;
  }

  return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>${subject}</title>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 20px auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px; }
                .button { display: inline-block; padding: 10px 20px; margin-top: 15px; background-color: #007bff; color: #ffffff; text-decoration: none; border-radius: 5px; }
            </style>
        </head>
        <body>
            <div class="container">
                ${body}
                <p>Best regards,<br>The Konar Card Team</p>
            </div>
        </body>
        </html>
    `;
};


module.exports = {
  verificationEmailTemplate,
  passwordResetTemplate,
  orderConfirmationTemplate,
  subscriptionConfirmationTemplate,
  trialEndingTemplate,
};