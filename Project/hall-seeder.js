const db = require('./db');

const DEFAULT_HALL_CONFIG = {
    hallId: 1,                 // Фиксированный ID для "Стандартного" зала
    hallName: 'Стандартный',   // Имя, которое будет отображаться
    rowCount: 8,               // 8 рядов
    seatsPerRow: 21             // 15 мест в ряду
};

async function seedDefaultHall() {
    const { hallId, hallName, rowCount, seatsPerRow } = DEFAULT_HALL_CONFIG;

    const upsertHallQuery = `
        INSERT INTO halls (hallid, name, rowscount, seatsperrow)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (hallid) 
        DO UPDATE SET 
            name = EXCLUDED.name,
            rowscount = EXCLUDED.rowscount,
            seatsperrow = EXCLUDED.seatsperrow
        RETURNING *;
    `;

    try {
        await db.query(upsertHallQuery, [hallId, hallName, rowCount, seatsPerRow]);
        console.log(`[SEEDER ✅] Зал ID ${hallId} ('${hallName}') успешно создан или обновлен.`);
        return hallId;
    } catch (error) {
        console.error(`[SEEDER ❌] Ошибка при создании/обновлении зала:`, error.message);
        throw error;
    }
}

module.exports = {
    seedDefaultHall,
    DEFAULT_HALL_CONFIG
};