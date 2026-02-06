const TelegramBot = require('node-telegram-bot-api');
const QRCode = require('qrcode');

// Импортируем функцию для получения бота из telegram-bot-handler.js
const { getBot } = require('./telegram-bot-handler');

function createReminderMessage(ticket) {
    const formattedTime = new Date(ticket.starttime).toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit'
    });
    const formattedDate = new Date(ticket.starttime).toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'long'
    });

    return `
🔔 *НАПОМИНАНИЕ О СЕАНСЕ*

🍿 *Фильм:* ${ticket.movie_title}
📅 *Когда:* ${formattedDate} в ${formattedTime}
📍 *Где:* Зал "${ticket.hall_name}"
🪑 *Ваше место:* Ряд ${ticket.rownum}, Место ${ticket.seatnum}

---
🎫 *QR-код билета прикреплен выше.* Предъявите его контроллеру.
Приятного просмотра!
`;
}

async function sendPhotoWithQrCode(chatId, ticket, caption) {
    const bot = getBot(); // <-- Получаем экземпляр бота

    if (!bot) {
        console.error('[Telegram Service] Бот не инициализирован');
        return;
    }

    if (!ticket.qrtoken) {
        console.warn(`[Telegram Service] Билет ID ${ticket.ticketid} не имеет QR-токена. Отправка только текста.`);
        return bot.sendMessage(chatId, caption, { parse_mode: 'Markdown' });
    }

    try {
        // 1. Генерируем QR-код как буфер из токена
        const qrBuffer = await QRCode.toBuffer(ticket.qrtoken, {
            errorCorrectionLevel: 'H',
            type: 'image/png',
            margin: 1,
            width: 256
        });

        // 2. Отправляем фото (QR-код) с подписью (текстом)
        await bot.sendPhoto(chatId, qrBuffer, {
            caption: caption,
            parse_mode: 'Markdown'
        }, {
            filename: `ticket_${ticket.ticketid}_qr.png`,
            contentType: 'image/png',
        });

        console.log(`[Telegram Service] Успешно отправлено уведомление с QR-кодом пользователю ${chatId} (Билет ${ticket.ticketid}).`);

    } catch (error) {
        console.error(`[Telegram Service] Критическая ошибка отправки QR-кода пользователю ${chatId}:`, error.message);
        await bot.sendMessage(chatId, `Напоминание о сеансе "${ticket.movie_title}". Произошла ошибка при отправке QR-кода. Пожалуйста, предъявите билет через сайт.`, { parse_mode: 'Markdown' });
    }
}

async function sendMessage(chatId, message) {
    const bot = getBot();

    if (!bot) {
        console.error('[Telegram Service] Бот не инициализирован');
        return false;
    }

    try {
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        console.log(`[Telegram Service] Успешно отправлено сообщение (только текст) пользователю с ID: ${chatId}`);
        return true;
    } catch (error) {
        console.error(`[Telegram Service] Ошибка отправки сообщения пользователю ${chatId}:`, error.message);
        return false;
    }
}

module.exports = {
    sendMessage,
    createReminderMessage,
    sendPhotoWithQrCode
};