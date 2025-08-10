// A new file: cron-job.js
const cron = require('node-cron');
const User = require('../models/user');
const sendEmail = require('../utils/SendEmail');
const { trialFirstReminderTemplate, trialFinalWarningTemplate } = require('../utils/emailTemplates');

// This cron job will run every minute
cron.schedule('* * * * *', async () => {
    console.log('Cron job is running to check for trial reminders.');
    const now = new Date();

    try {
        // Find users who are in their trial period, not subscribed, and trial has not expired
        const usersInTrial = await User.find({
            isSubscribed: false,
            trialExpires: { $exists: true, $gt: now },
        }).lean();

        for (const user of usersInTrial) {
            const trialExpiresDate = new Date(user.trialExpires);
            const timeRemainingMs = trialExpiresDate.getTime() - now.getTime();
            const minutesRemaining = timeRemainingMs / (1000 * 60);

            // First email reminder: Sent when time remaining is between 3 and 4 minutes.
            if (minutesRemaining >= 3 && minutesRemaining < 4 && !user.trialEmailRemindersSent.includes('first_reminder')) {
                try {
                    console.log(`Sending first trial reminder to ${user.email}.`);
                    await sendEmail({
                        email: user.email,
                        subject: 'Your Free Trial is About to End',
                        message: trialFirstReminderTemplate(user.name),
                    });
                    // Update user to mark email as sent
                    await User.findByIdAndUpdate(user._id, { $push: { trialEmailRemindersSent: 'first_reminder' } });
                } catch (err) {
                    console.error(`Error sending first reminder email to ${user.email}:`, err);
                }
            }

            // Second email reminder: Sent when time remaining is between 0.5 and 1.5 minutes.
            if (minutesRemaining >= 0.5 && minutesRemaining < 1.5 && !user.trialEmailRemindersSent.includes('final_warning')) {
                try {
                    console.log(`Sending final trial warning email to ${user.email}.`);
                    await sendEmail({
                        email: user.email,
                        subject: 'Last Chance! Your Trial Ends in Seconds',
                        message: trialFinalWarningTemplate(user.name),
                    });
                    // Update user to mark email as sent
                    await User.findByIdAndUpdate(user._id, { $push: { trialEmailRemindersSent: 'final_warning' } });
                } catch (err) {
                    console.error(`Error sending final reminder email to ${user.email}:`, err);
                }
            }
        }
    } catch (error) {
        console.error('Error in cron job:', error);
    }
});

module.exports = cron;