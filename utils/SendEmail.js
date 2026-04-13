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

    // Office365 requires the "from" to match the authenticated user (EMAIL_USER).
    // EMAIL_FROM is only used as a display-only reply-to fallback.
    const authUser = (process.env.EMAIL_USER || "").trim();
    const replyAddr = (process.env.EMAIL_FROM || authUser).trim();

    try {
        const info = await transporter.sendMail({
            from: `KonarCard <${authUser}>`,
            to,
            subject,
            html,
            replyTo: replyAddr,
        });

        console.log("[SendEmail] sent:", {
            to,
            subject,
            messageId: info?.messageId,
            accepted: info?.accepted,
            rejected: info?.rejected,
            response: info?.response,
        });

        return info;
    } catch (err) {
        console.error("[SendEmail] FAILED:", {
            to,
            subject,
            error: err?.message || err,
            code: err?.code,
            command: err?.command,
            responseCode: err?.responseCode,
        });
        throw err;
    }
};

module.exports = sendEmail;
