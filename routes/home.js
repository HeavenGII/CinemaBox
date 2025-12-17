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

router.get('/', async (req, res) => {
    const rawSearchTitle = req.query.searchTitle;
    const searchTitle = (rawSearchTitle && rawSearchTitle.trim().length > 0) ? rawSearchTitle.trim() : null;

    const filterYear = validateYear(req.query.year);
    const filterGenre = req.query.genre && req.query.genre.trim() !== '' ? req.query.genre.trim() : null;
    const filterMinRating = validateRating(req.query.minRating);

    const isFilterApplied = !!(searchTitle || filterYear || filterGenre || filterMinRating);

    const showOnlyActive = !isFilterApplied;

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
                ${firstScreeningIdSelect}
            FROM movies m
        `;

        if (showOnlyActive) {
            whereConditions.push(`m.isactive = true`);
        }

        if (searchTitle) {
            whereConditions.push(`m.title ILIKE $${paramCounter}`);
            queryParams.push(`%${searchTitle}%`);
            paramCounter++;
        }

        if (filterYear) {
            whereConditions.push(`m.releaseyear = $${paramCounter}`);
            queryParams.push(filterYear);
            paramCounter++;
        }

        if (filterGenre) {
            whereConditions.push(`m.genre ILIKE $${paramCounter}`);
            queryParams.push(`%${filterGenre}%`);
            paramCounter++;
        }

        if (filterMinRating) {
            whereConditions.push(`m.ratingavg >= $${paramCounter}`);
            queryParams.push(filterMinRating);
            paramCounter++;
        }

        if (whereConditions.length > 0) {
            baseQuery += ' WHERE ' + whereConditions.join(' AND ');
        }

        if (isFilterApplied) {
            baseQuery += ` ORDER BY m.ratingavg DESC, m.releaseyear DESC`;
        } else {
            baseQuery += ` ORDER BY m.ratingavg DESC, m.releaseyear DESC LIMIT 10`;
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
            isactive: m.isactive
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
            showOnlyActive,

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

router.get('/api/search', async (req, res) => {
    const query = req.query.query ? req.query.query.trim() : '';

    if (query.length < 2) {
        return res.status(200).json([]);
    }

    const queryParams = [`%${query}%`];

    try {
        const movieQueryText = `
            SELECT movieid AS id, title, posterurl, 'movie' AS type, ratingavg
            FROM movies
            WHERE title ILIKE $1
            ORDER BY ratingavg DESC
            LIMIT 5
        `;
        const movieResult = await db.query(movieQueryText, queryParams);

        const directorQueryText = `
            SELECT directorid AS id, name AS title, NULL AS posterurl, 'director' AS type, NULL AS ratingavg
            FROM directors
            WHERE name ILIKE $1
            ORDER BY name
            LIMIT 5
        `;
        const directorResult = await db.query(directorQueryText, queryParams);

        const combinedResults = [
            ...movieResult.rows.map(row => ({ id: row.id, title: row.title, poster: row.posterurl, type: 'movie' })),
            ...directorResult.rows.map(row => ({ id: row.id, title: row.title, poster: null, type: 'director' }))
        ].slice(0, 5);

        res.status(200).json(combinedResults);

    } catch (e) {
        console.error('Ошибка при выполнении AJAX поиска:', e);
        res.status(500).json({ error: 'Произошла ошибка сервера при поиске' });
    }
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