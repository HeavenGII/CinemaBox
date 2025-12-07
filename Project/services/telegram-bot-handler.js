const TelegramBot = require('node-telegram-bot-api');
const pool = require('../db');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8369747071:AAFDEOe_Veoqw4LeFyeIZqHPO3xFtVqLA44';

function setupBot() {
    try {
        const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

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

    } catch (error) {
        console.error("Критическая ошибка при инициализации Telegram Bot:", error.message);
    }
}

module.exports = {
    setupBot,
};