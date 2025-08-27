// previewEmails.js
const fs = require("fs");
const path = require("path");

// import your templates
const {
    verificationEmailTemplate,
    passwordResetTemplate,
    orderConfirmationTemplate,
    subscriptionConfirmationTemplate,
    trialFirstReminderTemplate,
    trialFinalWarningTemplate,
} = require("./utils/emailTemplates");

const outDir = path.join(__dirname, "email-previews");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

const samples = [
    {
        name: "verification.html",
        html: verificationEmailTemplate("John Doe", "123456"),
    },
    {
        name: "password-reset.html",
        html: passwordResetTemplate("John Doe", "https://example.com/reset/xyz"),
    },
    {
        name: "order-confirmation.html",
        html: orderConfirmationTemplate("john@example.com", "49.99"),
    },
    {
        name: "subscription-started.html",
        html: subscriptionConfirmationTemplate("John Doe", "9.99", "subscription_started"),
    },
    {
        name: "subscription-paid.html",
        html: subscriptionConfirmationTemplate("John Doe", "9.99", "subscription_paid"),
    },
    {
        name: "subscription-cancelled.html",
        html: subscriptionConfirmationTemplate("John Doe", "9.99", "subscription_cancelled"),
    },
    {
        name: "trial-first-reminder.html",
        html: trialFirstReminderTemplate("John Doe"),
    },
    {
        name: "trial-final-warning.html",
        html: trialFinalWarningTemplate("John Doe"),
    },
];

samples.forEach(({ name, html }) => {
    fs.writeFileSync(path.join(outDir, name), html, "utf8");
    console.log(`✔️ Generated ${name}`);
});

console.log(`\nOpen the "email-previews" folder and double-click the .html files to view them in your browser.`);
