// A new file: cron-job.js
const cron = require('node-cron');
const User = require('../models/user');
const sendEmail = require('../utils/SendEmail');
const { trialEndingTemplate } = require('./emailTemplates');
const lock = require('your-distributed-lock-library'); // You will need to install and configure a distributed lock library

// This cron job will run every minute
cron.schedule('* * * * *', async () => {
    console.log('Cron job is running to check for trial reminders.');
    const now = new Date();

    // Acquire a distributed lock to ensure only one instance runs this at a time
    const releaseLock = await lock.acquire('trial-reminder-lock', {
        timeout: 5000, // Wait for 5 seconds to acquire the lock
        retries: 3,    // Retry 3 times
    });

    if (!releaseLock) {
        console.log('Could not acquire lock. Another instance is already running the cron job.');
        return;
    }

    try {
        // Find users who are in their trial period and have not subscribed
        const usersInTrial = await User.find({
            isSubscribed: { $ne: true },
            trialExpires: { $exists: true, $gt: now },
        });

        for (const user of usersInTrial) {
            const trialExpiresDate = new Date(user.trialExpires);
            const timeRemainingMs = trialExpiresDate.getTime() - now.getTime();
            const minutesRemaining = timeRemainingMs / (1000 * 60);

            // Corrected check for the first email reminder (at the 3-minute mark)
            if (minutesRemaining >= 2.9 && minutesRemaining < 3.9 && !user.trialEmailRemindersSent.includes('first_reminder')) {
                try {
                    console.log(`Sending first trial reminder to ${user.email}.`);
                    await sendEmail({
                        email: user.email,
                        subject: 'Your Free Trial is About to End',
                        message: trialEndingTemplate(user.name, 'first_reminder'),
                    });
                    user.trialEmailRemindersSent.push('first_reminder');
                    await user.save();
                } catch (err) {
                    console.error(`Error sending first reminder email to ${user.email}:`, err);
                }
            }

            // Check for the second email reminder (at the 30-second mark)
            if (minutesRemaining <= 0.5 && !user.trialEmailRemindersSent.includes('final_warning')) {
                try {
                    console.log(`Sending final trial warning email to ${user.email}.`);
                    await sendEmail({
                        email: user.email,
                        subject: 'Last chance! Your trial ends in 30 seconds.',
                        message: trialEndingTemplate(user.name, 'final_warning'),
                    });
                    user.trialEmailRemindersSent.push('final_warning');
                    await user.save();
                } catch (err) {
                    console.error(`Error sending final reminder email to ${user.email}:`, err);
                }
            }
        }
    } catch (error) {
        console.error('Error in cron job:', error);
    } finally {
        // Release the lock when done, even if an error occurred
        await releaseLock();
    }
});

module.exports = cron;