const db = require('./db');

const DEFAULT_HALL_CONFIG = {
    hallId: 1,
    hallName: 'Стандартный',
    rowCount: 8,
    seatsPerRow: 21
};

async function seedDefaultHall() {
    const { hallId, hallName, rowCount, seatsPerRow } = DEFAULT_HALL_CONFIG;

    // Проверяем, существует ли таблица halls
    const checkTableQuery = `
        SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name = 'halls'
        );
    `;

    try {
        // Сначала проверяем существование таблицы
        const tableExists = await db.query(checkTableQuery);

        if (!tableExists.rows[0].exists) {
            throw new Error('Таблица "halls" не существует. Запустите миграции сначала.');
        }

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

        await db.query(upsertHallQuery, [hallId, hallName, rowCount, seatsPerRow]);
        console.log(`[SEEDER ✅] Зал ID ${hallId} ('${hallName}') успешно создан или обновлен.`);
        await setAdmin();
        return hallId;
    } catch (error) {
        console.error(`[SEEDER ❌] Ошибка при создании/обновлении зала:`, error.message);
        console.error('Подсказка: Запустите "npm run migrate" для создания таблиц.');
        throw error;
    }
}


async function setAdmin() {
    try {
        const plainPassword = '123456';
        const bcrypt = require('bcrypt');
        const hashedPassword = await bcrypt.hash(plainPassword, 10);

        // Сначала проверяем существование пользователя
        const checkUserQuery = `
            SELECT userid FROM users WHERE email = $1;
        `;

        const existingUser = await db.query(checkUserQuery, ['ilya.golovatskiy@gmail.com']);

        let result;

        if (existingUser.rows.length > 0) {
            // Обновляем существующего пользователя (без изменения ID)
            const updateUserQuery = `
                UPDATE users 
                SET password = $1, nickname = $2, role = $3
                WHERE email = $4
                RETURNING userid;
            `;
            result = await db.query(updateUserQuery, [
                hashedPassword,
                'admin',
                'Администратор',
                'ilya.golovatskiy@gmail.com'
            ]);
            console.log('✅ Администратор обновлён. ID:', result.rows[0].userid);
        } else {
            // Вставляем нового пользователя (используем MAX + 1 для ID)
            const insertUserQuery = `
                INSERT INTO users(userid, email, password, nickname, role)
                VALUES (
                    (SELECT COALESCE(MAX(userid), 0) + 1 FROM users),
                    $1, $2, $3, $4
                )
                RETURNING userid;
            `;
            result = await db.query(insertUserQuery, [
                'ilya.golovatskiy@gmail.com',
                hashedPassword,
                'admin',
                'Администратор'
            ]);
            console.log('✅ Администратор создан. ID:', result.rows[0].userid);
        }

        console.log('🔑 Логин: ilya.golovatskiy@gmail.com');
        console.log('🔑 Пароль: 123456');

        return result.rows[0].userid;
    } catch (error) {
        console.error('❌ Ошибка при создании администратора:', error.message);
        throw error;
    }
}

module.exports = {
    seedDefaultHall,
    DEFAULT_HALL_CONFIG,
};