const cron = require('node-cron');
const pool = require('../db');
const { sendPhotoWithQrCode, createReminderMessage } = require('./telegram-service');

const CRON_SCHEDULE = '*/5 * * * *';
const TARGET_HOURS_AHEAD = 48;
const SEARCH_BUFFER_MINUTES = 6;


async function markReminderSent(ticketId) {
    const updateQuery = `
        UPDATE tickets
        SET sent48hreminder = TRUE
        WHERE ticketid = $1;
    `;
    try {
        await pool.query(updateQuery, [ticketId]);
        console.log(`[DB Update] Статус напоминания установлен для Ticket ID: ${ticketId}`);
    } catch (err) {
        console.error(`Ошибка при установке флага sent48hreminder для Ticket ID ${ticketId}:`, err);
    }
}

async function getPrecise48HourAheadScreenings() {
    const now = new Date();

    const totalMinutesMin = TARGET_HOURS_AHEAD * 60 - SEARCH_BUFFER_MINUTES;
    const lowerBoundMs = totalMinutesMin * 60 * 1000;
    const startRange = new Date(now.getTime() + lowerBoundMs);

    const totalMinutesMax = TARGET_HOURS_AHEAD * 60 + SEARCH_BUFFER_MINUTES;
    const upperBoundMs = totalMinutesMax * 60 * 1000;
    const endRange = new Date(now.getTime() + upperBoundMs);

    const query = `
        SELECT
            t.ticketid,               
            u.telegramid, 
            t.rownum, 
            t.seatnum, 
            s.starttime, 
            m.title AS movie_title,
            h.name AS hall_name,
            t.qrtoken  -- 💡 НОВОЕ ПОЛЕ: Извлекаем QR-токен из таблицы tickets
        FROM 
            tickets t
        JOIN 
            users u ON t.userid = u.userid
        JOIN 
            screenings s ON t.screeningid = s.screeningid
        JOIN 
            movies m ON s.movieid = m.movieid
        JOIN
            halls h ON s.hallid = h.hallid
        WHERE 
            t.status = 'Оплачен' AND
            t.sent48hreminder = FALSE AND 
            (s.starttime AT TIME ZONE 'Europe/Minsk' AT TIME ZONE 'UTC') >= $1 AND 
            (s.starttime AT TIME ZONE 'Europe/Minsk' AT TIME ZONE 'UTC') < $2 AND
            u.telegramid IS NOT NULL AND
            u.enablenotifications = TRUE;
    `;

    try {
        console.log(`[DB Query] Interval: 5m. Window: 48h ± ${SEARCH_BUFFER_MINUTES}m.`);
        console.log(`[DB Query] Current time (UTC epoch): ${now.toISOString()}`);
        console.log(`[DB Query] Searching sessions in UTC range:`);
        console.log(`[DB Query] From: ${startRange.toISOString()}`);
        console.log(`[DB Query] To: ${endRange.toISOString()}`);

        const result = await pool.query(query, [startRange.toISOString(), endRange.toISOString()]);
        return result.rows;
    } catch (err) {
        console.error('Ошибка выполнения запроса для 48-часовых напоминаний:', err);
        return [];
    }
}


async function sendReminders() {
    console.log('Запуск рассылки напоминаний (проверка статуса "отправлено")...');

    const screenings = await getPrecise48HourAheadScreenings();

    if (screenings.length === 0) {
        return;
    }

    console.log(`Найдено ${screenings.length} НОВЫХ билетов для рассылки.`);

    for (const ticket of screenings) {
        // Создаем текст, который будет подписью к QR-коду
        const message = createReminderMessage(ticket);

        try {
            // 💡 Изменение: Вызываем новую функцию для отправки фото (QR) + текста
            await sendPhotoWithQrCode(ticket.telegramid, ticket, message);

            console.log(`[Success] Уведомление с QR отправлено пользователю ${ticket.telegramid} (Ticket ${ticket.ticketid}).`);

            // Если отправка прошла успешно, помечаем как отправленное
            await markReminderSent(ticket.ticketid);

            await new Promise(resolve => setTimeout(resolve, 500));

        } catch (error) {
            console.error(`[Telegram Service] Ошибка при отправке сообщения (с QR) пользователю ${ticket.telegramid} (Ticket ${ticket.ticketid}):`, error);
        }
    }

    console.log('Рассылка завершена.');
}


function startNotificationCron() {
    console.log(`Планировщик уведомлений запущен. Задача настроена на запуск каждые 5 минут (${CRON_SCHEDULE}).`);

    cron.schedule(CRON_SCHEDULE, () => {
        sendReminders();
    }, {
        scheduled: true,
        timezone: "Europe/Minsk"
    });
}


module.exports = {
    startNotificationCron,
};