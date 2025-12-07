-- 1. Таблица для хранения сессий Express (требуется для connect-pg-simple)
CREATE TABLE user_sessions (
    sid           VARCHAR       NOT NULL PRIMARY KEY,
    sess          JSON          NOT NULL,
    expire        TIMESTAMP(6)  NOT NULL
);

-- Создание индекса для ускорения очистки истекших сессий
CREATE INDEX idx_user_sessions_expire ON user_sessions (expire);

-- 2. Таблица пользователей
CREATE TABLE users (
    userid                  SERIAL        PRIMARY KEY,
    email                   VARCHAR(255)  UNIQUE NOT NULL,
    password                VARCHAR(255)  NOT NULL, -- Хэш пароля
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
CREATE TABLE directors (
    directorid  SERIAL        PRIMARY KEY,
    name        VARCHAR(255)  NOT NULL,
    biography   TEXT,
    birthdate   DATE,
    photourl    VARCHAR(255)
);

-- 4. Таблица фильмов
CREATE TABLE movies (
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
    price           DECIMAL(5, 2)
);

-- 5. Таблица залов
CREATE TABLE halls (
    hallid      SERIAL        PRIMARY KEY,
    name        VARCHAR(100)  UNIQUE NOT NULL,
    rowscount   INT           NOT NULL, -- Общее количество рядов
    seatsperrow INT           NOT NULL, -- Количество мест в ряду
    -- Проверка на корректность данных
    CHECK (rowscount > 0 AND seatsperrow > 0)
);

-- 6. Таблица сеансов
CREATE TABLE screenings (
    screeningid   SERIAL        PRIMARY KEY,
    movieid       INT           NOT NULL REFERENCES movies(movieid) ON DELETE CASCADE,
    hallid        INT           NOT NULL REFERENCES halls(hallid) ON DELETE RESTRICT,
    starttime     TIMESTAMP     NOT NULL, -- Дата и время начала сеанса
    iscancelled   BOOLEAN       NOT NULL DEFAULT FALSE -- Отмена сеанса (Администратор)
);

CREATE UNIQUE INDEX screenings_active_unique
ON screenings (hallid, starttime)
WHERE iscancelled = FALSE;


-- 7. Таблица билетов
CREATE TABLE tickets (
    ticketid            SERIAL        PRIMARY KEY,
    userid              INT           REFERENCES users(userid) ON DELETE SET NULL, -- Может быть NULL для гостя
    screeningid         INT           NOT NULL REFERENCES screenings(screeningid) ON DELETE CASCADE,
    rownum              INT           NOT NULL, -- Номер ряда
    seatnum             INT           NOT NULL, -- Номер места
    purchasetime        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status              VARCHAR(50)   NOT NULL DEFAULT 'Забронирован',
    totalprice          DECIMAL(8, 2) NOT NULL,
    qrtoken             VARCHAR(255),
    sent48hreminder     BOOLEAN       NOT NULL DEFAULT FALSE,
    reservationexpiresat TIMESTAMP,

    UNIQUE (screeningid, rownum, seatnum),
    UNIQUE (qrtoken)
);

-- 8. Таблица отзывов от пользователей
CREATE TABLE reviews (
    reviewid      SERIAL        PRIMARY KEY,
    userid        INT           NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
    movieid       INT           NOT NULL REFERENCES movies(movieid) ON DELETE CASCADE,
    comment       TEXT,
    createdat     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedat     TIMESTAMP,
    -- Один пользователь может оставить один отзыв на один фильм
    UNIQUE (userid, movieid) 
);

-- 9. Таблица оценок от пользователей (для расчета ratingavg в movies)
CREATE TABLE ratings (
    ratingid      SERIAL        PRIMARY KEY,
    userid        INT           NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
    movieid       INT           NOT NULL REFERENCES movies(movieid) ON DELETE CASCADE,
    ratingvalue   INT           NOT NULL CHECK (ratingvalue BETWEEN 1 AND 10), -- Оценка от 1 до 10
    ratedat       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Один пользователь может поставить одну оценку одному фильму
    UNIQUE (userid, movieid) 
);

-- 10. Таблица короткометражных видео к фильмам
CREATE TABLE shorts (
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