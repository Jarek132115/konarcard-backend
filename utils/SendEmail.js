// backend/utils/SendEmail.js
const nodemailer = require("nodemailer");

let cachedTransporter = null;

function buildTransporter() {
    const user = (process.env.EMAIL_USER || "").trim();
    const pass = (process.env.EMAIL_PASS || "").trim();

    if (!user || !pass) {
        throw new Error("EMAIL_USER / EMAIL_PASS missing in env");
    }

    const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST || "smtp.office365.com",
        port: Number(process.env.EMAIL_PORT || 587),
        secure: false, // STARTTLS on 587
        auth: { user, pass },

        // Office365 + Cloud Run stability
        requireTLS: true,
        tls: {
            minVersion: "TLSv1.2",
            servername: "smtp.office365.com",
        },

        pool: true,
        maxConnections: 2,
        maxMessages: 50,

        connectionTimeout: 20_000,
        greetingTimeout: 20_000,
        socketTimeout: 30_000,
    });

    return transporter;
}

async function getTransporter() {
    if (cachedTransporter) return cachedTransporter;
    cachedTransporter = buildTransporter();

    // Verify once so you SEE errors in logs immediately
    try {
        await cachedTransporter.verify();
        console.log("[SendEmail] SMTP verified OK");
    } catch (e) {
        console.error("[SendEmail] SMTP verify failed:", e?.message || e);
        // keep transporter, but this tells you instantly what’s wrong
    }

    return cachedTransporter;
}

const sendEmail = async (to, subject, html) => {
    const transporter = await getTransporter();

    const fromAddress =
        (process.env.EMAIL_FROM || process.env.EMAIL_USER || "").trim();

    const info = await transporter.sendMail({
        from: `KonarCard <${fromAddress}>`,
        to,
        subject,
        html,
        replyTo: fromAddress,
    });

    // This is IMPORTANT for debugging delivery
    console.log("[SendEmail] sent:", {
        to,
        subject,
        messageId: info?.messageId,
        accepted: info?.accepted,
        rejected: info?.rejected,
        response: info?.response,
    });

    return info;
};

module.exports = sendEmail;
