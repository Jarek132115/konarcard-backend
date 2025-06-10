const nodemailer = require('nodemailer');

const sendEmail = async (to, subject, html) => {
    const transporter = nodemailer.createTransport({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });

    await transporter.sendMail({
        from: `"KonarCard" <${process.env.EMAIL_USER}>`,
        to,
        subject,
        html
    });
};

module.exports = sendEmail;
