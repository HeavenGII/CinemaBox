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

// Функция для отправки уведомления о блокировке аккаунта
async function sendAccountBlockedEmail(userEmail, userName, refundedTickets, refundCount) {

    // Вычисляем общую сумму возврата
    const totalRefund = refundedTickets.reduce((sum, ticket) => sum + ticket.amount, 0);
    let ticketsSectionHTML = '';
    let ticketsSectionText = '';

    if (refundCount > 0) {
        let ticketsListHtml = '<h4>Возвращенные билеты:</h4><ul style="padding-left: 20px;">';

        refundedTickets.forEach(ticket => {
            ticketsListHtml += `
                <li style="margin-bottom: 5px;">
                    <strong>${ticket.movieTitle}</strong> | Сеанс: ${ticket.startTime} | Сумма: ${ticket.amount.toFixed(2)} BYN
                </li>
            `;
        });
        ticketsListHtml += '</ul>';

        ticketsSectionHTML = `
            <div style="background-color: #f0fff0; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 3px solid #4CAF50;">
                <h3 style="color: #4CAF50; margin-top: 0;">Автоматический возврат средств</h3>
                <p>Мы автоматически вернули оплату за <strong>${refundCount}</strong> билетов на предстоящие сеансы.</p>
                ${ticketsListHtml}
                <div style="padding: 10px; border-top: 1px solid #e0e0e0; margin-top: 10px;">
                    <p style="margin: 0; font-size: 16px; font-weight: bold; color: #2e7d32;">
                        Общая сумма возврата: <strong>${totalRefund.toFixed(2)} BYN</strong>
                    </p>
                </div>
                <p style="font-size: 14px; color: #666; margin-top: 10px;">
                    Средства будут зачислены на ваш счет в течение 3-5 рабочих дней.
                </p>
            </div>
        `;

        ticketsSectionText = `
        \n--- Информация о возвратах ---\n
        Мы автоматически вернули оплату за ${refundCount} билетов на предстоящие сеансы.
        Общая сумма возврата: ${totalRefund.toFixed(2)} BYN.
        Средства будут зачислены на ваш счет в течение 3-5 рабочих дней.
        `;

    } else {
        // Если возвратов 0
        ticketsSectionHTML = `
            <div style="background-color: #f8f8f8; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 3px solid #9e9e9e;">
                <p style="margin: 0;">Активных оплаченных билетов на будущие сеансы не найдено. Возврат средств не требуется.</p>
            </div>
        `;
        ticketsSectionText = '\nАктивных оплаченных билетов на будущие сеансы не найдено. Возврат средств не требуется.';
    }


    const mailOptions = {
        from: `"Кинотеатр CinemaBox" <${keys.SMTP_USER}>`,
        to: userEmail,
        // ИЗМЕНЕННАЯ ТЕМА: Более нейтральная
        subject: `Уведомление об удалении аккаунта CinemaBox`,

        html: `
            <!DOCTYPE html>
            <html lang="ru">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Уведомление об удалении аккаунта</title>
            </head>
            <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
                <div style="background-color: #f8f9fa; padding: 30px; border-radius: 10px; border-left: 4px solid #FF5722;">
                    <h2 style="color: #FF5722; margin-top: 0;">Уведомление об удалении аккаунта</h2>
                    
                    <p>Уважаемый(ая) <strong>${userName}</strong>,</p>
                    
                    <p>Сообщаем, что Ваш аккаунт в кинотеатре CinemaBox был **удален администратором** системы.</p>
                    
                    ${ticketsSectionHTML}
                    
                    <div style="background-color: #fff3e0; padding: 15px; border-radius: 5px; margin: 20px 0; border: 1px solid #ffcc80;">
                        <h4 style="color: #f57c00; margin-top: 0;">⚠️ Что это означает:</h4>
                        <ul style="margin-bottom: 0; padding-left: 20px;">
                            <li>Ваш аккаунт и связанные с ним данные удалены из системы.</li>
                            <li>Вы больше не сможете войти в систему, используя старые учетные данные.</li>
                        </ul>
                    </div>
                    
                    <p>Если вы считаете, что это произошло по ошибке, пожалуйста, свяжитесь с нашей службой поддержки по email: support@cinemabox.ru</p>
                    
                    <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #666;">
                        <p>Это автоматическое уведомление, пожалуйста, не отвечайте на это письмо.</p>
                        <p>С уважением,<br>Администрация кинотеатра <strong>CinemaBox</strong></p>
                    </div>
                </div>
            </body>
            </html>
        `,
        text: `Уважаемый(ая) ${userName},

Сообщаем, что Ваш аккаунт в кинотеатре CinemaBox был удален администратором системы.

${ticketsSectionText}

---
Что это означает:
- Ваш аккаунт и связанные с ним данные удалены из системы.
- Вы больше не сможете войти в систему.

Если вы считаете, что это произошло по ошибке, пожалуйста, свяжитесь с нашей службой поддержки по email: support@cinemabox.ru

С уважением,
Администрация кинотеатра CinemaBox`
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        // Возвращаем объект info, как ожидает роут
        return info;
    } catch (error) {
        console.error(`❌ Ошибка отправки email на ${userEmail}:`, error.message);
        throw error;
    }
}

async function sendScreeningCancellationEmail(userEmail, userName, screening, refundAmount) {

    const startTime = new Date(screening.starttime).toLocaleString('ru-RU');

    // 1. Секция возврата
    const refundInfoHTML = `
        <div style="background-color: #f0fff0; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 3px solid #4CAF50;">
            <h4 style="color: #4CAF50; margin-top: 0;">Автоматический возврат средств</h4>
            <p>Мы автоматически инициировали возврат средств за ваш билет.</p>
            <div style="padding: 10px; border-top: 1px solid #e0e0e0; margin-top: 10px;">
                <p style="margin: 0; font-size: 16px; font-weight: bold; color: #2e7d32;">
                    Общая сумма возврата: <strong>${refundAmount.toFixed(2)} BYN</strong>
                </p>
            </div>
            <p style="font-size: 14px; color: #666; margin-top: 10px;">
                Средства будут зачислены на ваш счет в течение 3-5 рабочих дней.
            </p>
        </div>
    `;

    const refundInfoText = `
    \n--- Информация о возврате ---\n
    Мы автоматически инициировали возврат средств за ваш билет.
    Сумма возврата: ${refundAmount.toFixed(2)} BYN.
    Средства будут зачислены на ваш счет в течение 3-5 рабочих дней.
    `;

    // 2. Настройка письма
    const mailOptions = {
        from: `"Кинотеатр CinemaBox" <${keys.SMTP_USER}>`,
        to: userEmail,
        subject: `⚠️ Сеанс отменен: "${screening.movie_title}" (${startTime})`,

        html: `
            <!DOCTYPE html>
            <html lang="ru">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Отмена сеанса</title>
            </head>
            <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
                <div style="background-color: #fff8e1; padding: 30px; border-radius: 10px; border-left: 4px solid #FFC107;">
                    <h2 style="color: #FFC107; margin-top: 0;">Отмена сеанса</h2>
                    
                    <p>Уважаемый(ая) <strong>${userName}</strong>,</p>
                    
                    <p>Сообщаем Вам, что сеанс, на который Вы приобрели билет, был отменен администрацией кинотеатра:</p>
                    
                    <div style="background-color: #ffffff; padding: 15px; border-radius: 5px; border: 1px solid #e0e0e0; margin: 20px 0;">
                        <p style="font-size: 16px; margin: 0;">
                            <strong>Фильм:</strong> ${screening.movie_title}<br>
                            <strong>Начало:</strong> ${startTime}<br>
                            <strong>Зал:</strong> ${screening.hall_name}
                        </p>
                    </div>

                    ${refundInfoHTML}
                    
                    <p>Приносим извинения за доставленные неудобства. Вы можете выбрать другой сеанс на нашем сайте.</p>
                    
                    <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #666;">
                        <p>Это автоматическое уведомление. С уважением,<br>Администрация кинотеатра <strong>CinemaBox</strong></p>
                    </div>
                </div>
            </body>
            </html>
        `,
        text: `Уважаемый(ая) ${userName},

Сообщаем Вам, что сеанс, на который Вы приобрели билет, был отменен администрацией кинотеатра:

Фильм: ${screening.movie_title}
Начало: ${startTime}
Зал: ${screening.hall_name}
${refundInfoText}

Приносим извинения за доставленные неудобства. Вы можете выбрать другой сеанс на нашем сайте.

С уважением,
Администрация кинотеатра CinemaBox`
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log(`✅ Email уведомление об отмене сеанса отправлено на ${userEmail}: ${info.messageId}`);
        return info;
    } catch (error) {
        console.error(`❌ Ошибка отправки email об отмене сеанса на ${userEmail}:`, error.message);
        throw error;
    }
}

// Функция для отправки письма о сбросе пароля
async function sendPasswordResetEmail(email, token) {
    const resetLink = `${keys.BASE_URL}/auth/reset-password?token=${token}`;

    const mailOptions = {
        to: email,
        from: keys.EMAIL_FROM,
        subject: 'Сброс пароля для вашего аккаунта',
        html: `
            <h1>Вы запросили сброс пароля</h1>
            <p>Если вы не запрашивали сброс пароля, проигнорируйте это письмо.</p>
            <p>Иначе, для сброса пароля перейдите по ссылке ниже:</p>
            <p>Ссылка действительна <strong>1 час</strong>.</p>
            <p><a href="${resetLink}">Сбросить пароль</a></p>
            <hr />
            <a href="${keys.BASE_URL}">На главную страницу кинотеатра</a>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
    } catch (error) {
        console.error('❌ Ошибка отправки email для сброса пароля:', error);
        throw error;
    }
}

module.exports = {
    sendPasswordResetEmail,
    sendAccountBlockedEmail,
    sendScreeningCancellationEmail
};