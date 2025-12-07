const nodemailer = require('nodemailer');
const keys = require('../keys');

const transporter = nodemailer.createTransport({
    host: keys.SMTP_HOST,
    port: keys.SMTP_PORT,
    secure: keys.SMTP_PORT === 465,
    auth: {
        user: keys.SMTP_USER,
        pass: keys.SMTP_PASSWORD,
    }
});


module.exports = function(email, token) {
    const resetLink = `${keys.BASE_URL}/auth/reset-password?token=${token}`;

    const mailOptions = {
        to: email,
        from: keys.EMAIL_FROM,
        subject: 'Сброс пароля для вашего аккаунта',
        html: `
            <h1>Вы запросили сброс пароля</h1>
            <p>Если вы не запрашивали сброс пароля, проигнорируйте это письмо.</p>
            <p>Иначе, для сброса пароля перейдите по ссылке ниже:</p>
            <p>Ссылка действительна **1 час**.</p>
            <p><a href="${resetLink}">Сбросить пароль</a></p>
            <hr />
            <a href="${keys.BASE_URL}">На главную страницу кинотеатра</a>
        `
    };

    return transporter.sendMail(mailOptions);
};