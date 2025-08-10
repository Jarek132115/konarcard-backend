// A new file: cron-job.js
const cron = require('node-cron');
const User = require('./models/user'); // Adjust path as needed
const sendEmail = require('./utils/SendEmail');
const { trialEndingTemplate } = require('./utils/emailTemplates'); // New email template

// This cron job will run every minute
cron.schedule('* * * * *', async () => {
    console.log('Cron job is running to check for trial reminders.');
    const now = Date.now();

    // Time windows for our emails (in milliseconds)
    const fiveMinutes = 5 * 60 * 1000;
    const oneMinute = 60 * 1000;
    const remainingTimeForEmail = fiveMinutes - (5 * 60 * 1000 - 3 * 60 * 1000); // This is the time remaining for the email to be sent at the 3-minute mark
    const remainingTimeForSecondEmail = fiveMinutes - (5 * 60 * 1000 - 4.5 * 60 * 1000); // Time remaining for the second email at the 4.5 minute mark

    // Find users who are in their trial period and have not subscribed
    const usersInTrial = await User.find({
        isSubscribed: { $ne: true }, // User is not on a paid subscription
        trialExpires: { $exists: true, $gt: now }, // Trial exists and has not expired
    });

    for (const user of usersInTrial) {
        const timeRemaining = user.trialExpires.getTime() - now;

        // Check for the first email reminder (at the 3-minute mark)
        if (timeRemaining <= 2 * 60 * 1000 && timeRemaining > 1.5 * 60 * 1000 && !user.trialEmailRemindersSent.includes('first_reminder')) {
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

        // Check for the second email reminder (at the 4.5-minute mark)
        if (timeRemaining <= 30 * 1000 && !user.trialEmailRemindersSent.includes('final_warning')) {
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
});

module.exports = cron;