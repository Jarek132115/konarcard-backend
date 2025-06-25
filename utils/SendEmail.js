// backend/utils/SendEmail.js
const nodemailer = require('nodemailer');

// Fix: sendEmail now accepts a single options object as its argument
const sendEmail = async (options) => { // 'options' is now the single parameter
    console.log("Backend: sendEmail function triggered.");
    console.log("Backend: Email options received:", options);

    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.office365.com', // Use environment variable or default
        port: process.env.SMTP_PORT || 587, // Use environment variable or default
        secure: process.env.SMTP_SECURE === 'true', // Use environment variable for secure flag
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });

    try {
        await transporter.sendMail({
            from: options.from || `"KonarCard" <${process.env.EMAIL_USER}>`, // Use options.from or default
            to: options.email, // Access the email from the options object
            subject: options.subject,
            html: options.message // Access the message from the options object
        });
        console.log("Backend: Email sent successfully to:", options.email);
    } catch (error) {
        console.error("Backend: Error sending email:", error);
        // Throw the error again so it's caught by the calling controller
        throw error;
    }
};

module.exports = sendEmail;