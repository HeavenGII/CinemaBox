const TelegramBot = require('node-telegram-bot-api');
const pool = require('../db');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8369747071:AAFDEOe_Veoqw4LeFyeIZqHPO3xFtVqLA44';
let bot; // <-- Глобальная переменная бота

function createScreeningCancellationMessage(screening, refundAmount, movieTitle, hallName, startTime) {
    const formattedTime = new Date(startTime).toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit'
    });
    const formattedDate = new Date(startTime).toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'long'
    });

    return `
❌ *СЕАНС ОТМЕНЕН*

🍿 *Фильм:* ${movieTitle}
📅 *Было запланировано:* ${formattedDate} в ${formattedTime}
📍 *Зал:* ${hallName}

${refundAmount > 0 ? `
💰 *Возврат средств:* ${refundAmount} руб.
Средства будут зачислены на ваш счет в течение 3-5 рабочих дней.
` : ''}

📞 *Причина:* Сеанс был отменен администратором кинотеатра.
Мы приносим извинения за доставленные неудобства.

🎬 *Что дальше?*
Вы можете выбрать другой сеанс этого фильма или оформить возврат.
Для получения помощи обратитесь в службу поддержки.
`;
}

// Функция для создания сообщения о блокировке аккаунта
function createAccountBlockedMessage(userName, refundedTickets, totalRefund) {
    let ticketsList = '';

    if (refundedTickets.length > 0) {
        ticketsList = '*Возвращенные билеты:*\n';
        refundedTickets.forEach((ticket, index) => {
            ticketsList += `${index + 1}. *${ticket.movieTitle}*\n   📅 ${ticket.startTime}\n   💰 ${ticket.amount} руб.\n`;
        });
    }

    return `
🔒 *ВАШ АККАУНТ БЫЛ ЗАБЛОКИРОВАН*

👤 *Пользователь:* ${userName}

${refundedTickets.length > 0 ? `
🔄 *Автоматические возвраты:*
Мы вернули оплату за ${refundedTickets.length} билетов на будущие сеансы.

${ticketsList}
💰 *Общая сумма возврата:* ${totalRefund.toFixed(2)} руб.
Средства будут зачислены на ваш счет в течение 3-5 рабочих дней.
` : ''}

⚠️ *Что это значит?*
• Ваш аккаунт был заблокирован администратором
• Вы больше не можете войти в систему
• Все активные бронирования аннулированы

📞 *Если это ошибка:*
Пожалуйста, свяжитесь с нашей службой поддержки для выяснения обстоятельств.
`;
}

// Функция для отправки уведомления об отмене сеанса
async function sendScreeningCancellationNotification(userTelegramId, screening, refundAmount) {
    if (!bot || !userTelegramId) {
        return false;
    }

    try {
        const message = createScreeningCancellationMessage(
            screening,
            refundAmount,
            screening.movie_title,
            screening.hall_name,
            screening.starttime
        );

        await bot.sendMessage(userTelegramId, message, { parse_mode: 'Markdown' });
        console.log(`[Telegram Service] Уведомление об отмене сеанса отправлено пользователю ${userTelegramId}`);
        return true;
    } catch (error) {
        console.error(`[Telegram Service] Ошибка отправки уведомления об отмене сеанса пользователю ${userTelegramId}:`, error.message);
        return false;
    }
}

// Функция для отправки уведомления о блокировке аккаунта
async function sendAccountBlockedNotification(userTelegramId, userName, refundedTickets, totalRefund) {
    if (!bot || !userTelegramId) {
        return false;
    }

    try {
        const message = createAccountBlockedMessage(userName, refundedTickets, totalRefund);
        await bot.sendMessage(userTelegramId, message, { parse_mode: 'Markdown' });
        console.log(`[Telegram Service] Уведомление о блокировке аккаунта отправлено пользователю ${userTelegramId}`);
        return true;
    } catch (error) {
        console.error(`[Telegram Service] Ошибка отправки уведомления о блокировке аккаунта пользователю ${userTelegramId}:`, error.message);
        return false;
    }
}

// Функция для получения экземпляра бота (для telegram-service.js)
function getBot() {
    if (!bot) {
        console.warn('[Telegram] Бот не инициализирован! Сначала вызовите setupBot()');
    }
    return bot;
}

// Основная функция инициализации бота
function setupBot() {
    try {
        // Создаем новый экземпляр бота только если его еще нет
        if (bot) {
            console.log('[Telegram Bot Handler] Бот уже инициализирован');
            return bot;
        }

        bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

        console.log('🤖 Telegram Bot запущен и готов принимать команды...');

        bot.onText(/\/start (.+)/, async (msg, match) => {
            const chatId = msg.chat.id;
            const linkToken = match[1].trim();
            const BOT_USERNAME = msg.from.username || 'неизвестный';

            if (linkToken.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(linkToken)) {
                bot.sendMessage(chatId, "❌ Неверный код привязки. Пожалуйста, сгенерируйте ссылку на сайте, чтобы начать привязку.", { parse_mode: 'Markdown' });
                return;
            }

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                const updateQuery = `
                    UPDATE users
                    SET telegramid = $1, enablenotifications = TRUE, telegramlinktoken = NULL 
                    WHERE telegramlinktoken = $2 AND telegramid IS NULL
                    RETURNING nickname, email;
                `;

                const { rows } = await client.query(updateQuery, [chatId, linkToken]);

                await client.query('COMMIT');

                if (rows.length > 0) {
                    const { nickname, email } = rows[0];
                    const successMessage = `
🎉 *Поздравляем, ${nickname}!*
Ваш аккаунт CinemaBox (Email: \`${email}\`) успешно привязан к этому чату.
Уведомления о сеансах включены!
                    `;
                    bot.sendMessage(chatId, successMessage, { parse_mode: 'Markdown' });
                    console.log(`[Bot Handler] Аккаунт ${email} привязан через Deep Link к ID ${chatId}.`);
                } else {
                    bot.sendMessage(chatId, "❌ Привязка не удалась: Ссылка истекла, код недействителен, или ваш аккаунт уже привязан.");
                }
            } catch (e) {
                await client.query('ROLLBACK');
                console.error(`[Bot Handler] Критическая ошибка при привязке через Deep Link от ${BOT_USERNAME} (${chatId}):`, e);
                bot.sendMessage(chatId, "❌ Критическая ошибка сервера при привязке. Попробуйте сгенерировать новую ссылку на сайте.");
            } finally {
                client.release();
            }
        });

        bot.onText(/^\/start$/, (msg) => {
            const chatId = msg.chat.id;
            const username = msg.from.username || 'пользователь';

            const welcomeMessage = `
👋 *Привет, ${username}!* Я бот кинотеатра CinemaBox.

🔗 *Как привязать аккаунт:*
1. Перейдите в настройки профиля на сайте.
2. Сгенерируйте и нажмите на *специальную ссылку привязки*.
            `;
            bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
            console.log(`[Bot Handler] Отправлено стандартное приветствие пользователю ${chatId}.`);
        });

        bot.onText(/\/id/, (msg) => {
            const chatId = msg.chat.id;
            const message = `
🗝️ *Ваш Telegram Chat ID:* \`${chatId}\`
    `;
            bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        });

        bot.on('polling_error', (error) => {
            if (error.code !== 'EHOSTUNREACH' && error.code !== 'ETIMEDOUT') {
                console.error("[Bot Handler] Ошибка Polling:", error.code, error.message);
            }
        });

        return bot; // Возвращаем экземпляр бота

    } catch (error) {
        console.error("Критическая ошибка при инициализации Telegram Bot:", error.message);
        throw error;
    }
}

module.exports = {
    setupBot,
    getBot,
    sendScreeningCancellationNotification,
    sendAccountBlockedNotification
};