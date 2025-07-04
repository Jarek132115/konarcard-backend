const nodemailer = require('nodemailer');

const sendEmail = async (options) => { 
    console.log("Backend: sendEmail function triggered.");
    console.log("Backend: Email options received:", options);

    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.office365.com', 
        port: process.env.SMTP_PORT || 587, 
        secure: process.env.SMTP_SECURE === 'true', 
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });

    try {
        await transporter.sendMail({
            from: options.from || `"KonarCard" <${process.env.EMAIL_USER}>`, 
            to: options.email, 
            subject: options.subject,
            html: options.message 
        });
        console.log("Backend: Email sent successfully to:", options.email);
    } catch (error) {
        console.error("Backend: Error sending email:", error);
        throw error;
    }
};

module.exports = sendEmail;