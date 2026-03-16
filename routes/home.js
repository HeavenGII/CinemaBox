const { Router } = require('express')
const db = require('../db')
const router = Router()

function getYouTubeId(url) {
    if (!url) return null;
    const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
    const match = url.match(regex);
    return match ? match[1] : null;
}

function validateYear(year) {
    if (!year) return null;
    const parsed = parseInt(year, 10);
    if (isNaN(parsed)) return null;

    const minYear = 1895;
    const maxYear = new Date().getFullYear() + 5;

    if (parsed < minYear || parsed > maxYear) {
        return null;
    }
    return parsed;
}

function validateRating(rating) {
    if (!rating) return null;
    const parsed = parseFloat(rating);
    if (isNaN(parsed)) return null;

    if (parsed < 0.0 || parsed > 10.0) {
        return null;
    }

    return parseFloat(parsed.toFixed(1));
}

// Главная страница - Афиша
router.get('/', async (req, res) => {
    const rawSearchTitle = req.query.searchTitle;
    const searchTitle = (rawSearchTitle && rawSearchTitle.trim().length > 0) ? rawSearchTitle.trim() : null;

    const filterYear = validateYear(req.query.year);
    const filterGenre = req.query.genre && req.query.genre.trim() !== '' ? req.query.genre.trim() : null;
    const filterMinRating = validateRating(req.query.minRating);

    const isFilterApplied = !!(searchTitle || filterYear || filterGenre || filterMinRating);

    let queryParams = [];
    let whereConditions = [];
    let paramCounter = 1;

    let foundDirectors = [];
    let currentMovies = [];
    let heroMovie = null;
    let allGenres = [];

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
        const genresResult = await db.query(`
            SELECT DISTINCT trim(unnest(string_to_array(genre, ','))) AS clean_genre 
            FROM movies 
            WHERE genre IS NOT NULL 
            ORDER BY clean_genre ASC
        `);
        allGenres = genresResult.rows.map(r => r.clean_genre);

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
                m.agerestriction,
                m.isactive,
                m.onlineenabled,
                ${firstScreeningIdSelect}
            FROM movies m
            WHERE m.isactive = true
        `;

        if (searchTitle) {
            baseQuery += ` AND m.title ILIKE $${paramCounter}`;
            queryParams.push(`%${searchTitle}%`);
            paramCounter++;
        }

        if (filterYear) {
            baseQuery += ` AND m.releaseyear = $${paramCounter}`;
            queryParams.push(filterYear);
            paramCounter++;
        }

        if (filterGenre) {
            baseQuery += ` AND m.genre ILIKE $${paramCounter}`;
            queryParams.push(`%${filterGenre}%`);
            paramCounter++;
        }

        if (filterMinRating) {
            baseQuery += ` AND m.ratingavg >= $${paramCounter}`;
            queryParams.push(filterMinRating);
            paramCounter++;
        }

        if (isFilterApplied) {
            baseQuery += ` ORDER BY m.ratingavg DESC, m.releaseyear DESC`;
        } else {
            baseQuery += ` ORDER BY m.releaseyear DESC`;
        }

        const movieResult = await db.query(baseQuery, queryParams);

        currentMovies = movieResult.rows.map(m => ({
            movield: m.movieid,
            title: m.title,
            posterurl: m.posterurl,
            genre: m.genre,
            durationmin: m.durationmin,
            rating: m.ratingavg,
            agerestriction: m.agerestriction,
            hasSessions: !!m.first_screening_id,
            firstScreeningId: m.first_screening_id,
            trailerurl: m.trailerurl,
            isactive: m.isactive,
            onlineenabled: m.onlineenabled
        }));

        if (currentMovies.length > 0) {
            const activeMovies = currentMovies.filter(m => m.isactive);
            if (activeMovies.length > 0) {
                heroMovie = activeMovies[Math.floor(Math.random() * activeMovies.length)];
            } else {
                heroMovie = currentMovies[0];
            }

            if (heroMovie && heroMovie.trailerurl) {
                const youtubeId = getYouTubeId(heroMovie.trailerurl);
                if (youtubeId) {
                    heroMovie.trailerYoutubeId = youtubeId;
                }
            }
        }

        res.render('index', {
            title: isFilterApplied ? 'Результаты поиска' : 'Афиша CinemaВох',
            currentMovies,
            foundDirectors,
            heroMovie,
            allGenres,
            searchTitle,
            filterYear,
            filterGenre,
            filterMinRating,
            isFilterApplied,
            showOnlyActive: true,
            currentYear: new Date().getFullYear(),
            isHome: true,
            isOnline: false
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
            isHome: true,
            isOnline: false
        });
    }
});

// Маршрут для онлайн-фильмов
router.get('/online', async (req, res) => {
    const rawSearchTitle = req.query.searchTitle;
    const searchTitle = (rawSearchTitle && rawSearchTitle.trim().length > 0) ? rawSearchTitle.trim() : null;

    const filterYear = validateYear(req.query.year);
    const filterGenre = req.query.genre && req.query.genre.trim() !== '' ? req.query.genre.trim() : null;
    const filterMinRating = validateRating(req.query.minRating);

    const isFilterApplied = !!(searchTitle || filterYear || filterGenre || filterMinRating);

    let queryParams = [];
    let whereConditions = ['onlineenabled = true'];
    let paramCounter = 1;

    // Получаем список всех жанров для фильтра
    let allGenres = [];
    try {
        const genresResult = await db.query(`
            SELECT DISTINCT trim(unnest(string_to_array(genre, ','))) AS clean_genre 
            FROM movies 
            WHERE genre IS NOT NULL 
            ORDER BY clean_genre ASC
        `);
        allGenres = genresResult.rows.map(r => r.clean_genre);
    } catch (e) {
        console.error('Ошибка при загрузке жанров:', e);
    }

    if (searchTitle) {
        whereConditions.push(`title ILIKE $${paramCounter}`);
        queryParams.push(`%${searchTitle}%`);
        paramCounter++;
    }

    if (filterYear) {
        whereConditions.push(`releaseyear = $${paramCounter}`);
        queryParams.push(filterYear);
        paramCounter++;
    }

    if (filterGenre) {
        whereConditions.push(`genre ILIKE $${paramCounter}`);
        queryParams.push(`%${filterGenre}%`);
        paramCounter++;
    }

    if (filterMinRating) {
        whereConditions.push(`ratingavg >= $${paramCounter}`);
        queryParams.push(filterMinRating);
        paramCounter++;
    }

    try {
        const query = `
            SELECT
                m.movieid,
                m.title,
                m.posterurl,
                m.genre,
                m.durationmin,
                m.ratingavg,
                m.price,
                m.isactive,
                m.agerestriction,
                m.onlineenabled,
                m.qualities,
                d.name AS directorname,
                EXISTS (
                    SELECT 1 FROM screenings s 
                    WHERE s.movieid = m.movieid 
                      AND s.starttime > NOW() 
                      AND s.iscancelled = FALSE
                ) AS hassessions
            FROM movies m
            JOIN directors d ON m.directorid = d.directorid
            WHERE ${whereConditions.join(' AND ')}
            ORDER BY m.releaseyear DESC
        `;

        const result = await db.query(query, queryParams);
        const movies = result.rows;

        res.render('movies/movie-catalog', {
            title: isFilterApplied ? 'Результаты поиска' : 'Онлайн-фильмы',
            movies: movies,
            searchTitle,
            filterYear,
            filterGenre,
            filterMinRating,
            isFilterApplied,
            isOnline: true,
            isHome: false,
            isSoon: false,
            allGenres: allGenres, // ← передаем жанры для фильтра
            currentYear: new Date().getFullYear()
        });

    } catch (e) {
        console.error('Ошибка при загрузке онлайн-фильмов:', e);
        res.status(500).render('error', {
            title: 'Ошибка',
            message: 'Не удалось загрузить онлайн-фильмы.'
        });
    }
});

router.get('/api/search', async (req, res) => {
    const query = req.query.q ? req.query.q.trim() : '';

    if (query.length < 2) {
        return res.status(200).json([]);
    }

    const queryParams = [`%${query}%`];

    try {
        // Поиск фильмов
        const movieQuery = `
            SELECT 
                movieid AS id, 
                title, 
                posterurl, 
                'movie' AS type, 
                ratingavg,
                releaseyear
            FROM movies
            WHERE title ILIKE $1
            ORDER BY 
                CASE 
                    WHEN isactive THEN 1
                    WHEN onlineenabled THEN 2
                    ELSE 3
                END,
                ratingavg DESC
            LIMIT 5
        `;
        const movieResult = await db.query(movieQuery, queryParams);

        // Поиск режиссеров
        const directorQuery = `
            SELECT 
                directorid AS id, 
                name AS title, 
                photourl AS posterurl, 
                'director' AS type
            FROM directors
            WHERE name ILIKE $1
            ORDER BY name
            LIMIT 5
        `;
        const directorResult = await db.query(directorQuery, queryParams);

        // Объединяем результаты
        const combinedResults = [
            ...movieResult.rows.map(row => ({
                id: row.id,
                title: row.title,
                poster: row.posterurl,
                type: row.type,
                year: row.releaseyear,
                rating: row.ratingavg
            })),
            ...directorResult.rows.map(row => ({
                id: row.id,
                title: row.title,
                poster: row.posterurl,
                type: row.type
            }))
        ].slice(0, 8); // Ограничиваем до 8 результатов

        res.status(200).json(combinedResults);

    } catch (e) {
        console.error('Ошибка при выполнении AJAX поиска:', e);
        res.status(500).json({ error: 'Произошла ошибка сервера при поиске' });
    }
});

router.get('/search', async (req, res) => {
    const searchQuery = req.query.q ? req.query.q.trim() : '';
    const filterYear = validateYear(req.query.year);
    const filterGenre = req.query.genre && req.query.genre.trim() !== '' ? req.query.genre.trim() : null;
    const filterMinRating = validateRating(req.query.minRating);

    const isFilterApplied = !!(searchQuery || filterYear || filterGenre || filterMinRating);

    let movieQueryParams = [];
    let movieWhereConditions = [];
    let paramCounter = 1;

    // Получаем список всех жанров для фильтра
    let allGenres = [];
    try {
        const genresResult = await db.query(`
            SELECT DISTINCT trim(unnest(string_to_array(genre, ','))) AS clean_genre 
            FROM movies 
            WHERE genre IS NOT NULL 
            ORDER BY clean_genre ASC
        `);
        allGenres = genresResult.rows.map(r => r.clean_genre);
    } catch (e) {
        console.error('Ошибка при загрузке жанров:', e);
    }

    // ПОИСК ФИЛЬМОВ
    let movieQuery = `
        SELECT
            m.movieid,
            m.title,
            m.posterurl,
            m.genre,
            m.durationmin,
            m.ratingavg,
            m.price,
            m.isactive,
            m.agerestriction,
            m.onlineenabled,
            m.qualities,
            d.name AS directorname,
            EXISTS (
                SELECT 1 FROM screenings s 
                WHERE s.movieid = m.movieid 
                  AND s.starttime > NOW() 
                  AND s.iscancelled = FALSE
            ) AS hassessions
        FROM movies m
        JOIN directors d ON m.directorid = d.directorid
        WHERE 1=1
    `;

    if (searchQuery) {
        movieQuery += ` AND m.title ILIKE $${paramCounter}`;
        movieQueryParams.push(`%${searchQuery}%`);
        paramCounter++;
    }

    if (filterYear) {
        movieQuery += ` AND m.releaseyear = $${paramCounter}`;
        movieQueryParams.push(filterYear);
        paramCounter++;
    }

    if (filterGenre) {
        movieQuery += ` AND m.genre ILIKE $${paramCounter}`;
        movieQueryParams.push(`%${filterGenre}%`);
        paramCounter++;
    }

    if (filterMinRating) {
        movieQuery += ` AND m.ratingavg >= $${paramCounter}`;
        movieQueryParams.push(filterMinRating);
        paramCounter++;
    }

    movieQuery += ` ORDER BY m.releaseyear DESC`;

    // ПОИСК РЕЖИССЕРОВ
    let directors = [];
    if (searchQuery) {
        try {
            const directorQuery = `
                SELECT
                    directorid,
                    name,
                    photourl,
                    biography
                FROM directors
                WHERE name ILIKE $1
                ORDER BY name
                LIMIT 10
            `;
            const directorResult = await db.query(directorQuery, [`%${searchQuery}%`]);
            directors = directorResult.rows;
        } catch (e) {
            console.error('Ошибка при поиске режиссеров:', e);
        }
    }

    // ВЫПОЛНЯЕМ ПОИСК ФИЛЬМОВ
    let movies = [];
    try {
        const movieResult = await db.query(movieQuery, movieQueryParams);
        movies = movieResult.rows;
    } catch (e) {
        console.error('Ошибка при поиске фильмов:', e);
    }

    // Считаем количество в каждой категории
    const activeCount = movies.filter(m => m.isactive).length;
    const onlineCount = movies.filter(m => m.onlineenabled).length;
    const upcomingCount = movies.filter(m => !m.isactive && !m.onlineenabled).length;

    res.render('search/results', {
        title: isFilterApplied ? 'Результаты поиска' : 'Поиск фильмов',
        searchQuery: searchQuery,
        filterYear: filterYear,
        filterGenre: filterGenre,
        filterMinRating: filterMinRating,
        isFilterApplied: isFilterApplied,
        movies: movies,
        directors: directors,
        allGenres: allGenres,
        currentYear: new Date().getFullYear(),
        activeCount: activeCount,
        onlineCount: onlineCount,
        upcomingCount: upcomingCount
    });
});

router.get('/contacts', (req, res) => {
    res.render('contactInformation/contacts', {
        title: 'Контакты CinemaVox',
        isContacts: true
    });
});

router.get('/shorts', async (req, res) => {
    try {
        const filterMovieId = req.query.movieid;

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

router.get('/rules', (req, res) => {
    res.render('rules', {
        title: 'Правила кинотеатра'
    });
});

module.exports = router