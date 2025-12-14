require('dotenv').config();
const { Pool } = require('pg');

async function runMigrations() {
    console.log('🚀 Начинаем миграции базы данных...');

    // Создаем пул соединений
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? {
            rejectUnauthorized: false
        } : false
    });

    const client = await pool.connect();

    try {
        console.log('📊 Подключение к базе данных...');

        // Проверяем существование таблиц
        const checkTablesQuery = `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      AND table_name IN (
        'user_sessions', 'users', 'directors', 'movies', 
        'halls', 'screenings', 'tickets', 'reviews', 
        'ratings', 'shorts', 'payment_metadata', 'refunds'
      );
    `;

        const existingTables = await client.query(checkTablesQuery);
        console.log(`✅ Найдено таблиц: ${existingTables.rows.length}`);

        // Если таблиц нет - создаем все
        if (existingTables.rows.length === 0) {
            console.log('🔄 Создаем структуру базы данных...');

            // SQL для создания таблиц (ваш код)
            const createTablesSQL = `
        -- 1. Таблица для хранения сессий Express
        CREATE TABLE IF NOT EXISTS user_sessions (
            sid           VARCHAR       NOT NULL PRIMARY KEY,
            sess          JSON          NOT NULL,
            expire        TIMESTAMP(6)  NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_user_sessions_expire ON user_sessions (expire);

        -- 2. Таблица пользователей
        CREATE TABLE IF NOT EXISTS users (
            userid                  SERIAL        PRIMARY KEY,
            email                   VARCHAR(255)  UNIQUE NOT NULL,
            password                VARCHAR(255)  NOT NULL,
            nickname                VARCHAR(255)  NOT NULL UNIQUE,
            firstname               VARCHAR(100),
            lastname                VARCHAR(100),
            phone                   VARCHAR(20)   UNIQUE,
            enablenotifications     BOOLEAN       NOT NULL DEFAULT TRUE,
            telegramid              BIGINT        UNIQUE,
            telegramlinktoken       VARCHAR(32),
            role                    VARCHAR(50)   NOT NULL DEFAULT 'Пользователь',
            resetpasswordtoken VARCHAR(255),
            resetpasswordexpires TIMESTAMP
        );

        -- 3. Таблица режиссеров
        CREATE TABLE IF NOT EXISTS directors (
            directorid  SERIAL        PRIMARY KEY,
            name        VARCHAR(255)  NOT NULL,
            biography   TEXT,
            birthdate   DATE,
            photourl    VARCHAR(255)
        );

        -- 4. Таблица фильмов
        CREATE TABLE IF NOT EXISTS movies (
            movieid         SERIAL        PRIMARY KEY,
            title           VARCHAR(255)  NOT NULL,
            originaltitle   VARCHAR(255)  NOT NULL,
            description     TEXT,
            durationmin     INT           NOT NULL,
            genre           VARCHAR(100),
            posterurl       VARCHAR(255),
            trailerurl      VARCHAR(255),
            releaseyear     INT,
            directorid      INT           REFERENCES directors(directorid) ON DELETE SET NULL,
            ratingavg       DECIMAL(3, 1) DEFAULT 0.0,
            isactive        BOOLEAN       NOT NULL DEFAULT TRUE,
            price           DECIMAL(5, 2),
            agerestriction INT NOT NULL DEFAULT 0
        );

        -- 5. Таблица залов
        CREATE TABLE IF NOT EXISTS halls (
            hallid      SERIAL        PRIMARY KEY,
            name        VARCHAR(100)  UNIQUE NOT NULL,
            rowscount   INT           NOT NULL,
            seatsperrow INT           NOT NULL,
            CHECK (rowscount > 0 AND seatsperrow > 0)
        );

        -- 6. Таблица сеансов
        CREATE TABLE IF NOT EXISTS screenings (
            screeningid   SERIAL        PRIMARY KEY,
            movieid       INT           NOT NULL REFERENCES movies(movieid) ON DELETE CASCADE,
            hallid        INT           NOT NULL REFERENCES halls(hallid) ON DELETE RESTRICT,
            starttime     TIMESTAMP     NOT NULL,
            iscancelled   BOOLEAN       NOT NULL DEFAULT FALSE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS screenings_active_unique
        ON screenings (hallid, starttime)
        WHERE iscancelled = FALSE;

        -- 7. Таблица билетов
        CREATE TABLE IF NOT EXISTS tickets (
            ticketid            SERIAL        PRIMARY KEY,
            userid              INT           REFERENCES users(userid) ON DELETE SET NULL,
            screeningid         INT           NOT NULL REFERENCES screenings(screeningid) ON DELETE CASCADE,
            rownum              INT           NOT NULL,
            seatnum             INT           NOT NULL,
            purchasetime        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            status              VARCHAR(50)   NOT NULL DEFAULT 'Забронирован',
            totalprice          DECIMAL(8, 2) NOT NULL,
            qrtoken             VARCHAR(255),
            sent48hreminder     BOOLEAN       NOT NULL DEFAULT FALSE,
            reservationexpiresat TIMESTAMP,
            refundedat TIMESTAMP,
            UNIQUE (qrtoken)
        );

        -- 8. Таблица отзывов
        CREATE TABLE IF NOT EXISTS reviews (
            reviewid      SERIAL        PRIMARY KEY,
            userid        INT           NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
            movieid       INT           NOT NULL REFERENCES movies(movieid) ON DELETE CASCADE,
            comment       TEXT,
            createdat     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updatedat     TIMESTAMP,
            UNIQUE (userid, movieid) 
        );

        -- 9. Таблица оценок
        CREATE TABLE IF NOT EXISTS ratings (
            ratingid      SERIAL        PRIMARY KEY,
            userid        INT           NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
            movieid       INT           NOT NULL REFERENCES movies(movieid) ON DELETE CASCADE,
            ratingvalue   INT           NOT NULL CHECK (ratingvalue BETWEEN 1 AND 10),
            ratedat       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (userid, movieid) 
        );

        -- 10. Таблица короткометражных видео
        CREATE TABLE IF NOT EXISTS shorts (
            shortid SERIAL PRIMARY KEY,
            movieid INTEGER NOT NULL,
            title VARCHAR(255) NOT NULL,
            videopath VARCHAR(512) NOT NULL,
            durationsec INTEGER,
            uploaddate TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_movie
                FOREIGN KEY(movieid)
                REFERENCES movies(movieid)
                ON DELETE CASCADE
        );

        -- Таблица для хранения метаданных платежей ЮKassa
        CREATE TABLE IF NOT EXISTS payment_metadata (
            id SERIAL PRIMARY KEY,
            payment_id VARCHAR(100) UNIQUE NOT NULL,
            yookassa_payment_id VARCHAR(100) UNIQUE NOT NULL,
            order_id VARCHAR(100) NOT NULL,
            user_id INTEGER REFERENCES users(userid),
            amount DECIMAL(10, 2) NOT NULL,
            currency VARCHAR(10) NOT NULL,
            status VARCHAR(50) NOT NULL,
            description TEXT,
            ticket_token VARCHAR(255) UNIQUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        -- Таблица для хранения информации о возвратах
        CREATE TABLE IF NOT EXISTS refunds (
            id SERIAL PRIMARY KEY,
            ticket_id INTEGER REFERENCES tickets(ticketid),
            payment_id VARCHAR(100),
            refund_id VARCHAR(100) UNIQUE NOT NULL,
            amount DECIMAL(10, 2) NOT NULL,
            currency VARCHAR(10) NOT NULL,
            status VARCHAR(50) NOT NULL,
            reason TEXT,
            yookassa_payment_id VARCHAR(100),
            is_simulated BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            processed_at TIMESTAMP
        );

        -- Индексы для ускорения поиска
        CREATE INDEX IF NOT EXISTS idx_payment_metadata_user_id ON payment_metadata(user_id);
        CREATE INDEX IF NOT EXISTS idx_payment_metadata_ticket_token ON payment_metadata(ticket_token);
        CREATE INDEX IF NOT EXISTS idx_refunds_ticket_id ON refunds(ticket_id);
      `;

            await client.query(createTablesSQL);
            console.log('✅ Все таблицы успешно созданы!');

            // Создаем стандартный зал
            console.log('🎬 Создаем стандартный зал...');
            await client.query(`
        INSERT INTO halls (hallid, name, rowscount, seatsperrow)
        VALUES (1, 'Стандартный', 8, 21)
        ON CONFLICT (hallid) DO NOTHING;
      `);

            console.log('✅ Стандартный зал создан!');

            // Создаем тестового администратора
            console.log('👑 Создаем администратора...');
            const bcrypt = require('bcrypt');
            const hashedPassword = await bcrypt.hash('123456', 10);

            await client.query(`
        INSERT INTO users (email, password, nickname, role)
        VALUES ('ilya.golovatskiy@gmail.com', $1, 'admin', 'Администратор')
        ON CONFLICT (email) DO UPDATE SET
          password = EXCLUDED.password,
          nickname = EXCLUDED.nickname,
          role = EXCLUDED.role;
      `, [hashedPassword]);

            console.log('✅ Администратор создан!');
            console.log('📧 Логин: ilya.golovatskiy@gmail.com');
            console.log('🔑 Пароль: 123456');

        } else {
            console.log('✅ Таблицы уже существуют, пропускаем создание.');
        }

        console.log('🎉 Миграции завершены успешно!');

    } catch (error) {
        console.error('❌ Ошибка при выполнении миграций:', error.message);
        console.error(error.stack);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
        console.log('🔌 Соединение с базой данных закрыто.');
        process.exit(0);
    }
}

runMigrations();