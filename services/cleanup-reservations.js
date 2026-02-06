const cron = require('node-cron');
const pool = require('../db');

// Запускаем каждые 5 минут
cron.schedule('*/5 * * * *', async () => {
    try {
        const result = await pool.query(`
            DELETE FROM tickets 
            WHERE status = 'Забронирован' 
            AND reservationexpiresat <= NOW()
            RETURNING ticketid;
        `);

        if (result.rows.length > 0) {
            console.log(`Очищено ${result.rows.length} истекших бронирований`);
        }
    } catch (error) {
        console.error('Ошибка при очистке бронирований:', error);
    }
});