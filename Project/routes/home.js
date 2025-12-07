const { Router } = require('express')
const db = require('../db')
const router = Router()

// 💡 НОВАЯ ФУНКЦИЯ: Утилита для извлечения 11-значного ID видео из любого URL YouTube
function getYouTubeId(url) {
    if (!url) return null;
    // Регулярное выражение для захвата ID из форматов watch?v=, youtu.be/, embed/ и т.д.
    const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
    const match = url.match(regex);
    return match ? match[1] : null;
}


router.get('/', async (req, res) => {
    // 1. Получаем параметры из запроса
    const rawSearchTitle = req.query.searchTitle;
    const searchTitle = (rawSearchTitle && rawSearchTitle.trim().length > 0) ? rawSearchTitle.trim() : null;

    // Параметры фильтрации
    const filterYear = req.query.year ? parseInt(req.query.year) : null;
    const filterGenre = req.query.genre && req.query.genre !== '' ? req.query.genre : null;
    const filterMinRating = req.query.minRating ? parseFloat(req.query.minRating) : null;

    // Флаг: применен ли хоть какой-то фильтр или поиск?
    const isFilterApplied = !!(searchTitle || filterYear || filterGenre || filterMinRating);

    let queryParams = [];
    let whereConditions = [];
    let paramCounter = 1;

    let foundDirectors = [];
    let currentMovies = [];
    let heroMovie = null;
    let allGenres = [];

    // Подзапрос для ближайшего сеанса
    const firstScreeningIdSelect = `
        (
            SELECT s.screeningid
            FROM screenings s
            WHERE s.movieid = m.movieid
              AND s.starttime >= NOW() - interval '10 minutes' 
              AND s.iscancelled = FALSE
            ORDER BY s.starttime ASC
            LIMIT 1
        ) AS first_screening_id
    `;

    try {
        // --- 2. Получаем список всех жанров (РАЗБИВАЕМ СТРОКИ НА СЛОВА) ---
        // unnest(string_to_array(genre, ',')) превращает "боевик, драма" в две строки: "боевик" и " драма"
        // trim() убирает лишние пробелы
        const genresResult = await db.query(`
            SELECT DISTINCT trim(unnest(string_to_array(genre, ','))) AS clean_genre 
            FROM movies 
            WHERE genre IS NOT NULL 
            ORDER BY clean_genre ASC
        `);
        allGenres = genresResult.rows.map(r => r.clean_genre);

        // --- 3. Строим основной запрос для фильмов ---
        let baseQuery = `
            SELECT
                m.movieid,
                m.title,
                m.posterurl,
                m.genre,
                m.durationmin,
                m.ratingavg,
                m.releaseyear,
                m.trailerurl,
                ${firstScreeningIdSelect}
            FROM movies m
        `;

        // А. Фильтр по названию
        if (searchTitle) {
            whereConditions.push(`m.title ILIKE $${paramCounter}`);
            queryParams.push(`%${searchTitle}%`);
            paramCounter++;
        }

        // Б. Фильтр по году
        if (filterYear) {
            whereConditions.push(`m.releaseyear = $${paramCounter}`);
            queryParams.push(filterYear);
            paramCounter++;
        }

        // В. Фильтр по жанру (ИСПРАВЛЕНО: ищем вхождение)
        if (filterGenre) {
            // Ищем 'драма' внутри строки 'боевик, драма, спорт'
            whereConditions.push(`m.genre ILIKE $${paramCounter}`);
            queryParams.push(`%${filterGenre}%`);
            paramCounter++;
        }

        // Г. Фильтр по рейтингу
        if (filterMinRating) {
            whereConditions.push(`m.ratingavg >= $${paramCounter}`);
            queryParams.push(filterMinRating);
            paramCounter++;
        }

        // Если есть условия, добавляем WHERE
        if (whereConditions.length > 0) {
            baseQuery += ' WHERE ' + whereConditions.join(' AND ');
        }

        // Сортировка
        if (isFilterApplied) {
            baseQuery += ` ORDER BY m.ratingavg DESC, m.releaseyear DESC`;
        } else {
            // По умолчанию топ-10
            baseQuery += ` ORDER BY m.ratingavg DESC, m.releaseyear DESC LIMIT 10`;
        }

        const movieResult = await db.query(baseQuery, queryParams);

        currentMovies = movieResult.rows.map(m => ({
            movield: m.movieid,
            title: m.title,
            posterurl: m.posterurl,
            genre: m.genre, // Здесь остается строка "боевик, драма", это нормально для отображения
            durationmin: m.durationmin,
            rating: m.ratingavg,
            hasSessions: !!m.first_screening_id,
            firstScreeningId: m.first_screening_id,
            trailerurl: m.trailerurl
        }));

        // --- 4. Поиск режиссеров (только если есть текст) ---
        if (searchTitle) {
            const directorQueryText = `
                SELECT d.directorid, d.name FROM directors d
                WHERE d.name ILIKE $1
                ORDER BY d.name
            `;
            // Создаем новый массив параметров, чтобы не путать с фильтрами фильмов
            const directorResult = await db.query(directorQueryText, [`%${searchTitle}%`]);

            foundDirectors = directorResult.rows.map(d => ({
                directorId: d.directorid,
                fullName: d.name
            }));
        }

        // --- 5. Выбор Hero Movie ---
        if (currentMovies.length > 0) {
            // Если есть результаты поиска, берем случайный из них, иначе случайный из топ-10
            heroMovie = currentMovies[Math.floor(Math.random() * currentMovies.length)];

            if (heroMovie && heroMovie.trailerurl) {
                const youtubeId = getYouTubeId(heroMovie.trailerurl);
                if (youtubeId) {
                    heroMovie.trailerYoutubeId = youtubeId;
                }
            }
        }

        // --- 6. Рендеринг ---
        res.render('index', {
            title: isFilterApplied ? 'Результаты поиска' : 'Афиша CinemaВох',

            currentMovies,
            foundDirectors,
            heroMovie,
            allGenres, // Передаем чистый список жанров

            // Сохраняем состояние фильтров
            searchTitle,
            filterYear,
            filterGenre,
            filterMinRating,
            isFilterApplied,

            currentYear: new Date().getFullYear(),
            isHome: true
        });

    } catch (e) {
        console.error('Ошибка при загрузке главной страницы:', e);
        res.render('index', {
            title: 'Афиша CinemaВох',
            currentMovies: [],
            foundDirectors: [],
            heroMovie: null,
            allGenres: [],
            error: 'Не удалось выполнить поиск или загрузить фильмы',
            isHome: true
        });
    }
});

// AJAX-эндпоинт для автозаполнения поиска
router.get('/api/search', async (req, res) => {
    const query = req.query.query ? req.query.query.trim() : '';

    if (query.length < 2) {
        return res.status(200).json([]);
    }

    const queryParams = [`%${query}%`];

    try {
        // Поиск фильмов
        const movieQueryText = `
            SELECT movieid AS id, title, posterurl, 'movie' AS type, ratingavg
            FROM movies
            WHERE title ILIKE $1
            ORDER BY ratingavg DESC
            LIMIT 5
        `;
        const movieResult = await db.query(movieQueryText, queryParams);

        // Поиск режиссеров
        const directorQueryText = `
            SELECT directorid AS id, name AS title, NULL AS posterurl, 'director' AS type, NULL AS ratingavg
            FROM directors
            WHERE name ILIKE $1
            ORDER BY name
            LIMIT 5
        `;
        const directorResult = await db.query(directorQueryText, queryParams);

        // Объединение и ограничение результатов (всего 5)
        const combinedResults = [
            ...movieResult.rows.map(row => ({ id: row.id, title: row.title, poster: row.posterurl, type: 'movie' })),
            ...directorResult.rows.map(row => ({ id: row.id, title: row.title, poster: null, type: 'director' }))
        ].slice(0, 5);

        res.status(200).json(combinedResults);

    } catch (e) {
        console.error('Ошибка при выполнении AJAX поиска:', e);
        // В случае ошибки возвращаем ошибку сервера
        res.status(500).json({ error: 'Произошла ошибка сервера при поиске' });
    }
});

router.get('/contacts', (req, res) => {
    res.render('contactInformation/contacts', {
        title: 'Контакты CinemaVox',
        isContacts: true // Для подсветки активной ссылки в шапке
    });
});

// GET /shorts - Главная страница для просмотра коротких видео
router.get('/shorts', async (req, res) => {
    try {
        const filterMovieId = req.query.movieid;

        // 1. ПОЛУЧЕНИЕ НАЗВАНИЯ ФИЛЬМА (для заголовка и сообщений)
        let movieTitle = null;
        if (filterMovieId) {
            const movieResult = await db.query('SELECT title FROM movies WHERE movieid = $1', [filterMovieId]);
            if (movieResult.rows.length > 0) {
                movieTitle = movieResult.rows[0].title;
            }
        }

        let query = `
            SELECT 
                s.shortid, 
                s.title AS short_title, 
                s.videopath, 
                s.durationsec, 
                m.title AS movie_title,
                m.movieid
            FROM shorts s
            JOIN movies m ON s.movieid = m.movieid
        `;
        let queryParams = [];
        let title = 'Короткие видео';

        // 2. ФИЛЬТРАЦИЯ ЗАПРОСА
        if (filterMovieId) {
            query += ` WHERE s.movieid = $1`;
            queryParams.push(filterMovieId);
            title = movieTitle ? `Шортсы к фильму: ${movieTitle}` : 'Шортсы (Фильм не найден)';
        }

        query += ` ORDER BY s.shortid DESC;`;

        const { rows: shorts } = await db.query(query, queryParams);

        if (shorts.length === 0) {
            return res.render('shorts', {
                title: title,
                shorts: [],
                message: filterMovieId && movieTitle ?
                    `Для фильма "${movieTitle}" нет загруженных шортсов.` :
                    'Пока нет загруженных коротких видео.'
            });
        }

        res.render('shorts', {
            title: title,
            shorts: shorts,
            isShorts: true,
            filterMovieId: filterMovieId,
            movieTitle: movieTitle
        });

    } catch (e) {
        console.error('Ошибка при загрузке коротких видео:', e);
        res.status(500).render('error', { message: 'Ошибка сервера при загрузке видео.' });
    }
});

module.exports = router