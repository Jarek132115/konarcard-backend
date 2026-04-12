// backend/jobs/paymentReminder.js
// Sends a reminder email to users whose subscription renews tomorrow.
// Called daily by node-cron in server.js.

const User = require("../models/user");
const sendEmail = require("../utils/SendEmail");
const { paymentReminderTemplate } = require("../utils/emailTemplates");

async function sendPaymentReminders() {
    const now = new Date();

    // Tomorrow window: start of tomorrow → end of tomorrow (UTC)
    const tomorrowStart = new Date(now);
    tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);
    tomorrowStart.setUTCHours(0, 0, 0, 0);

    const tomorrowEnd = new Date(tomorrowStart);
    tomorrowEnd.setUTCHours(23, 59, 59, 999);

    try {
        const users = await User.find({
            isSubscribed: true,
            subscriptionStatus: { $in: ["active", "trialing"] },
            currentPeriodEnd: { $gte: tomorrowStart, $lte: tomorrowEnd },
        }).select("name email currentPeriodEnd");

        if (!users.length) {
            console.log("[paymentReminder] No renewals tomorrow.");
            return;
        }

        console.log(`[paymentReminder] Sending reminders to ${users.length} user(s)...`);

        for (const user of users) {
            const renewDate = user.currentPeriodEnd
                ? user.currentPeriodEnd.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
                : "tomorrow";

            try {
                await sendEmail(
                    user.email,
                    "Your KonarCard subscription renews tomorrow",
                    paymentReminderTemplate(user.name, renewDate)
                );
            } catch (err) {
                console.error(`[paymentReminder] Failed for ${user.email}:`, err?.message);
            }
        }

        console.log("[paymentReminder] Done.");
    } catch (err) {
        console.error("[paymentReminder] Job error:", err);
    }
}

module.exports = sendPaymentReminders;
