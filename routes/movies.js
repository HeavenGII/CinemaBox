const { Router } = require('express');
const router = Router();
const crypto = require('crypto');
const pool = require('../db');
const { body, validationResult } = require('express-validator');
const authMiddleware = require('../middleware/auth');
const QRCode = require('qrcode');
const { formatDate, getScreeningDayLabel } = require("../utils/hbs-helpers");

function extractYouTubeId(url) {
    if (!url) return null;
    const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|\w\?v=)|youtu\.be\/)([^&]+)/;
    const match = url.match(regex);
    return match ? match[1] : null;
}

// GET /movies - Полный каталог фильмов (и категория "Скоро")
router.get('/', async (req, res) => {
    try {
        const { searchTitle, category } = req.query;

        let query = `
            SELECT
                m.movieid,
                m.title,
                m.posterurl,
                m.genre,
                m.durationmin,
                m.ratingavg,
                m.price,
                m.isactive,
                m.agerestriction,  -- ← ДОБАВЛЕНО!
                d.name AS directorname,
                -- НОВОЕ ПОЛЕ: Проверяем наличие будущих сеансов для фильма
                EXISTS (
                    SELECT 1
                    FROM screenings s -- Используем screenings, как в вашей схеме
                    WHERE s.movieid = m.movieid 
                      AND s.starttime > NOW() 
                      AND s.iscancelled = FALSE -- Исключаем отмененные сеансы
                ) AS hassessions
            FROM movies m
            JOIN directors d ON m.directorid = d.directorid
        `;
        let queryParams = [];
        let whereClauses = [];
        let title = 'Афиша (Фильмы в прокате)';
        let isHome = true;
        let isSoon = false;

        // --- ЛОГИКА ФИЛЬТРАЦИИ ПО КАТЕГОРИИ ---
        if (category === 'soon') {
            // Если выбрано "Скоро", показываем только неактивные фильмы
            whereClauses.push(`m.isactive = FALSE`);
            title = 'Скоро в прокате';
            isHome = false;
            isSoon = true;
        } else {
            // По умолчанию (Афиша) показываем только активные фильмы
            whereClauses.push(`m.isactive = TRUE`);
        }

        // --- ЛОГИКА ПОИСКА ---
        if (searchTitle && searchTitle.trim()) {
            queryParams.push(`%${searchTitle.trim()}%`);
            whereClauses.push(`m.title ILIKE $${queryParams.length}`);
            title = (isSoon ? 'Скоро: ' : 'Афиша: ') + `Результаты поиска "${searchTitle}"`;
        }

        if (whereClauses.length > 0) {
            query += ' WHERE ' + whereClauses.join(' AND ');
        }

        // Сортировка: активные сверху, затем по году релиза
        query += ' ORDER BY m.isactive DESC, m.releaseyear DESC;';

        const result = await pool.query(query, queryParams);
        const movies = result.rows;

        res.render('movies/movie-catalog', {
            title: title,
            isMovies: true,
            isHome: isHome,
            isSoon: isSoon,
            searchTitle: searchTitle,
            movies: movies
        });

    } catch (e) {
        console.error('Ошибка при загрузке Каталога фильмов:', e);
        res.status(500).render('error', {
            title: 'Ошибка',
            message: 'Не удалось загрузить полный каталог фильмов с сервера.'
        });
    }
});

// GET /movies/:id - Страница с деталями фильма
router.get('/:id', async (req, res) => {
    const movieId = req.params.id;

    if (!movieId) {
        return res.status(404).render('404', { title: 'Фильм не найден' });
    }

    try {
        const movieResult = await pool.query(`
            SELECT
                m.movieid, m.title, m.description, m.durationmin, m.genre,
                m.posterurl, m.trailerurl, m.releaseyear, m.ratingavg, m.price,
                m.isactive, m.agerestriction,  -- ← ДОБАВЛЕНО!
                d.name AS directorname, d.directorid
            FROM movies m
            JOIN directors d ON m.directorid = d.directorid
            WHERE m.movieid = $1
        `, [movieId]);

        const movie = movieResult.rows[0];

        if (!movie) {
            return res.status(404).render('404', { title: 'Фильм не найден' });
        }

        const shortsQuery = `
            SELECT 
                shortid, title, videopath, durationsec
            FROM shorts
            WHERE movieid = $1
            ORDER BY uploaddate DESC;
        `;
        const shortsResult = await pool.query(shortsQuery, [movieId]);
        const movieShorts = shortsResult.rows;

        const reviewsQuery = `
            SELECT
                r.reviewid, r.comment AS reviewtext, r.createdat, r.userid,
                u.nickname, rt.ratingvalue AS rating
            FROM reviews r
            JOIN users u ON r.userid = u.userid
            JOIN ratings rt ON r.movieid = rt.movieid AND r.userid = rt.userid
            WHERE r.movieid = $1
            ORDER BY r.createdat DESC;
        `;
        const reviewsResult = await pool.query(reviewsQuery, [movieId]);
        let allReviews = reviewsResult.rows;

        const screeningsQuery = `
            SELECT
                s.screeningid, s.starttime, h.name as hallname
            FROM screenings s
            JOIN halls h on s.hallid = h.hallid
            WHERE s.movieid = $1
            AND s.iscancelled = false
            AND s.starttime >= now() - interval '10 minutes'
            ORDER BY s.starttime asc;
        `;
        const screeningsResult = await pool.query(screeningsQuery, [movieId]);
        const allUpcomingScreenings = screeningsResult.rows;

        const firstUpcomingScreening = allUpcomingScreenings.length > 0 ? allUpcomingScreenings[0] : null;

        const isAuthenticated = !!req.session.user;
        let currentUserReview = null;
        let otherReviews = allReviews;
        let canReview = isAuthenticated;

        if (isAuthenticated) {
            const userId = req.session.user.userId;

            const userReviewIndex = allReviews.findIndex(r => r.userid === userId);

            if (userReviewIndex !== -1) {
                currentUserReview = allReviews[userReviewIndex];

                otherReviews = [
                    ...allReviews.slice(0, userReviewIndex),
                    ...allReviews.slice(userReviewIndex + 1)
                ];

                canReview = false;
            }
        }

        const trailerId = extractYouTubeId(movie.trailerurl);
        res.render('movies/details', {
            title: `Билеты на ${movie.title}`,
            movie: {
                ...movie,
                trailerId: trailerId
            },
            movieShorts: movieShorts,
            firstUpcomingScreening: firstUpcomingScreening,
            allUpcomingScreenings: allUpcomingScreenings,
            reviews: otherReviews,
            currentUserReview: currentUserReview,
            isAuthenticated: isAuthenticated,
            canReview: canReview,
            error: req.flash('error')[0] || null,
            success: req.flash('success')[0] || null,
            isMoviePage: true
        });

    } catch (e) {
        console.error(`Ошибка при загрузке фильма ID ${movieId}:`, e);
        res.status(500).render('error', { title: 'Ошибка сервера' });
    }
});

// POST /movies/:id/review - Логика добавления ИЛИ ОБНОВЛЕНИЯ отзыва
router.post('/:id/review', authMiddleware, [
    body('rating', 'Рейтинг должен быть от 1 до 5 звезд.').isInt({ min: 1, max: 5 }),
    body('reviewText', 'Отзыв не может содержать более 500 символов.')
        .trim().isLength({ max: 500 })
], async (req, res) => {
    const movieId = req.params.id;
    const userId = req.session.user.userId;
    const { rating, reviewText } = req.body;
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
        req.flash('error', errors.array()[0].msg);
        return req.session.save(() => res.redirect(`/movies/${movieId}#reviews-section`));
    }

    try {

        const existingReview = await pool.query(
            'SELECT 1 FROM reviews WHERE movieid = $1 AND userid = $2',
            [movieId, userId]
        );

        const isUpdating = existingReview.rows.length > 0;
        await pool.query('BEGIN');
        let flashMessage = '';
        if (isUpdating) {
            const updateReviewQuery = `
                UPDATE reviews SET comment = $3, createdat = CURRENT_TIMESTAMP
                WHERE movieid = $1 AND userid = $2;
            `;
            await pool.query(updateReviewQuery, [movieId, userId, reviewText]);

            const updateRatingQuery = `
                UPDATE ratings SET ratingvalue = $3
                WHERE movieid = $1 AND userid = $2;
            `;
            await pool.query(updateRatingQuery, [movieId, userId, rating]);

            flashMessage = 'Ваш отзыв успешно обновлен!';

        } else {
            const insertReviewQuery = `
                INSERT INTO reviews (movieid, userid, comment)
                VALUES ($1, $2, $3);
            `;
            await pool.query(insertReviewQuery, [movieId, userId, reviewText]);

            const insertRatingQuery = `
                INSERT INTO ratings (movieid, userid, ratingvalue)
                VALUES ($1, $2, $3);
            `;
            await pool.query(insertRatingQuery, [movieId, userId, rating]);

            flashMessage = 'Ваш отзыв успешно опубликован!';
        }
        const updateAvgRatingQuery = `
            WITH AvgRating AS (
                SELECT ROUND(AVG(ratingvalue)::numeric, 1) AS new_rating_avg
                FROM ratings
                WHERE movieid = $1
            )
            UPDATE movies m
            SET ratingavg = ar.new_rating_avg
            FROM AvgRating ar
            WHERE m.movieid = $1;
        `;
        await pool.query(updateAvgRatingQuery, [movieId]);

        await pool.query('COMMIT');

        req.flash('success', flashMessage);
        req.session.save(() => res.redirect(`/movies/${movieId}#reviews-section`));

    } catch (e) {
        await pool.query('ROLLBACK');
        console.error(`Ошибка при публикации/обновлении отзыва для фильма ID ${movieId}:`, e);
        req.flash('error', 'Произошла критическая ошибка при публикации/обновлении отзыва.');
        req.session.save(() => res.redirect(`/movies/${movieId}#reviews-section`));
    }
});


// POST /movies/review/edit/:reviewId - Роут для редактирования отзыва по его ID (С ПРОВЕРКОЙ ВЛАДЕНИЯ)
router.post('/review/edit/:reviewId', authMiddleware, [
    body('rating', 'Рейтинг должен быть от 1 до 5 звезд.').isInt({ min: 1, max: 5 }),
    body('reviewText', 'Отзыв не может быть пустым и должен содержать не более 500 символов.')
        .trim().isLength({ min: 1, max: 500 })
], async (req, res) => {
    const reviewId = req.params.reviewId;
    const userId = req.session.user.userId;
    const { rating, reviewText, movieId } = req.body;
    const errors = validationResult(req);

    if (!errors.isEmpty() || !movieId) {
        req.flash('error', errors.array()[0]?.msg || 'Отсутствует ID фильма.');
        return req.session.save(() => res.redirect(movieId ? `/movies/${movieId}#reviews-section` : '/'));
    }

    try {
        await pool.query('BEGIN');

        const reviewCheck = await pool.query(
            'SELECT userid FROM reviews WHERE reviewid = $1',
            [reviewId]
        );

        const review = reviewCheck.rows[0];

        if (!review) {
            await pool.query('ROLLBACK');
            req.flash('error', 'Отзыв для редактирования не найден.');
            return req.session.save(() => res.redirect(`/movies/${movieId}#reviews-section`));
        }

        if (review.userid !== userId) {
            await pool.query('ROLLBACK');
            req.flash('error', 'У вас нет прав для редактирования этого отзыва.');
            console.warn(`IDOR Attempt: User ${userId} tried to edit review ${reviewId} owned by ${review.userid}`);
            return req.session.save(() => res.status(403).redirect(`/movies/${movieId}#reviews-section`));
        }

        const updateReviewQuery = `
            UPDATE reviews SET comment = $1, createdat = CURRENT_TIMESTAMP
            WHERE reviewid = $2;
        `;
        await pool.query(updateReviewQuery, [reviewText, reviewId]);

        const updateRatingQuery = `
            UPDATE ratings SET ratingvalue = $3
            WHERE movieid = $1 AND userid = $2;
        `;
        await pool.query(updateRatingQuery, [movieId, userId, rating]);

        const updateAvgRatingQuery = `
            WITH AvgRating AS (
                SELECT ROUND(AVG(ratingvalue)::numeric, 1) AS new_rating_avg
                FROM ratings
                WHERE movieid = $1
            )
            UPDATE movies m
            SET ratingavg = ar.new_rating_avg
            FROM AvgRating ar
            WHERE m.movieid = $1;
        `;
        await pool.query(updateAvgRatingQuery, [movieId]);

        await pool.query('COMMIT');

        req.flash('success', 'Ваш отзыв успешно обновлен!');
        req.session.save(() => res.redirect(`/movies/${movieId}#reviews-section`));

    } catch (e) {
        await pool.query('ROLLBACK');
        console.error(`Ошибка при редактировании отзыва ID ${reviewId}:`, e);
        req.flash('error', 'Произошла критическая ошибка при редактировании отзыва.');
        req.session.save(() => res.redirect(`/movies/${movieId}#reviews-section`));
    }
});


// POST /movies/:id/review/delete - Логика удаления отзыва (С ПРОВЕРКОЙ ВЛАДЕНИЯ)
router.post('/:id/review/delete', authMiddleware, async (req, res) => {
    const movieId = req.params.id;
    const userId = req.session.user.userId;

    try {
        await pool.query('BEGIN');

        const reviewCheck = await pool.query(
            'SELECT userid FROM reviews WHERE movieid = $1 AND userid = $2',
            [movieId, userId]
        );

        if (reviewCheck.rows.length === 0) {
            await pool.query('ROLLBACK');
            req.flash('error', 'Отзыв для удаления не найден или принадлежит другому пользователю.');
            return req.session.save(() => res.status(403).redirect(`/movies/${movieId}#reviews-section`));
        }

        await pool.query('DELETE FROM reviews WHERE movieid = $1 AND userid = $2', [movieId, userId]);
        await pool.query('DELETE FROM ratings WHERE movieid = $1 AND userid = $2', [movieId, userId]);

        const updateRatingQuery = `
            WITH AvgRating AS (
                SELECT ROUND(AVG(ratingvalue)::numeric, 1) AS new_rating_avg
                FROM ratings
                WHERE movieid = $1
            )
            UPDATE movies m
            SET ratingavg = COALESCE(ar.new_rating_avg, 0)
            FROM AvgRating ar
            WHERE m.movieid = $1;
        `;
        await pool.query(updateRatingQuery, [movieId]);

        await pool.query('COMMIT');

        req.flash('success', 'Ваш отзыв и оценка были успешно удалены.');
        req.session.save(() => res.redirect(`/movies/${movieId}#reviews-section`));

    } catch (e) {
        await pool.query('ROLLBACK');
        console.error(`Ошибка при удалении отзыва для фильма ID ${movieId}:`, e);
        req.flash('error', 'Произошла критическая ошибка при удалении отзыва.');
        req.session.save(() => res.redirect(`/movies/${movieId}#reviews-section`));
    }
});


// GET /movies/:movieId/select-time - Маршрут для выбора сеанса и мест
router.get('/:movieId/select-time',authMiddleware, async (req, res) => {
    const { movieId } = req.params;

    if (!movieId || isNaN(parseInt(movieId))) {
        return res.status(400).render('error', {
            title: 'Ошибка',
            message: 'Некорректный идентификатор фильма.'
        });
    }

    try {
        const allScreeningsQuery = `
            SELECT
                s.screeningid, s.starttime,
                m.title AS movietitle, m.price AS baseprice,
                h.hallid, h.name AS hallname, h.rowscount, h.seatsperrow
            FROM screenings s
            JOIN movies m ON s.movieid = m.movieid
            JOIN halls h ON s.hallid = h.hallid
            WHERE s.movieid = $1
            AND s.iscancelled = FALSE
            AND s.starttime >= NOW() - interval '10 minutes'
            ORDER BY s.starttime ASC;
        `;
        const { rows: allScreenings } = await pool.query(allScreeningsQuery, [movieId]);

        if (allScreenings.length === 0) {
            return res.status(404).render('error', {
                title: 'Нет сеансов',
                message: 'Для этого фильма нет доступных сеансов.'
            });
        }

        const firstScreening = allScreenings[0];
        const initialScreeningId = firstScreening.screeningid;

        const bookedSeatsQuery = `
            SELECT rownum, seatnum
            FROM tickets
            WHERE screeningid = $1 
            AND (
                status = 'Оплачен' 
                OR status = 'Бронь'
                OR (status = 'Забронирован' AND reservationexpiresat > NOW())
            );
        `;
        const { rows: bookedSeats } = await pool.query(bookedSeatsQuery, [initialScreeningId]);
        const bookedSeatKeys = bookedSeats.map(seat => `${seat.rownum}-${seat.seatnum}`);

        const groupedScreenings = allScreenings.reduce((acc, scr) => {
            const dateISO = scr.starttime.toISOString();

            const dayLabel = getScreeningDayLabel(dateISO);

            if (!acc[dayLabel]) {
                acc[dayLabel] = {
                    dateLabel: dayLabel,
                    screenings: []
                };
            }

            acc[dayLabel].screenings.push({
                id: scr.screeningid,
                startTime: formatDate(dateISO, 'HH:mm'),
                fullDisplayTime: formatDate(dateISO, 'DD.MM. HH:mm'),
                hall: scr.hallname,
                basePrice: parseFloat(scr.baseprice)
            });

            return acc;
        }, {});

        const jsScreeningsGrouped = Object.values(groupedScreenings);

        const initialSeatData = {
            id: initialScreeningId,
            movieTitle: firstScreening.movietitle,
            hall: firstScreening.hallname,
            rowsCount: firstScreening.rowscount,
            seatsPerRow: firstScreening.seatsperrow,
            basePrice: parseFloat(firstScreening.baseprice),
            bookedSeatKeys: bookedSeatKeys,
            startTime: formatDate(firstScreening.starttime.toISOString(), 'DD.MM.YYYY HH:mm'),
        };


        res.render('movies/seats', {
            title: `Выбор мест: ${firstScreening.movietitle}`,
            movieTitle: firstScreening.movietitle,
            movieId: movieId,
            initialData: JSON.stringify({
                screenings: jsScreeningsGrouped,
                initialSeatData: initialSeatData
            }),
            isAuthenticated: !!req.session.user
        });

    } catch (e) {
        console.error('Ошибка при получении данных для выбора мест:', e);
        res.status(500).render('error', {
            title: 'Ошибка сервера',
            message: 'Не удалось загрузить схему мест.'
        });
    }
});

// GET /movies/api/seats/:sessionId - API для динамической подгрузки схемы (НОВЫЙ)
router.get('/api/seats/:sessionId', async (req, res) => {
    const { sessionId } = req.params;

    try {
        const screeningQuery = `
            SELECT
                s.screeningid, s.starttime,
                m.title AS movietitle, m.price AS baseprice,
                h.name AS hallname, h.rowscount, h.seatsperrow
            FROM screenings s
            JOIN movies m ON s.movieid = m.movieid
            JOIN halls h ON s.hallid = h.hallid
            WHERE s.screeningid = $1 AND s.iscancelled = FALSE;
        `;
        const { rows: screeningRows } = await pool.query(screeningQuery, [sessionId]);

        const screening = screeningRows[0];
        if (!screening) {
            return res.status(404).json({ error: 'Сеанс не найден.' });
        }

        const bookedSeatsQuery = `
            SELECT rownum, seatnum
            FROM tickets
            WHERE screeningid = $1 
            AND (
                status = 'Оплачен' 
                OR status = 'Бронь'
                OR (status = 'Забронирован' AND reservationexpiresat > NOW())
            );
        `;
        const { rows: bookedSeats } = await pool.query(bookedSeatsQuery, [sessionId]);
        const bookedSeatKeys = bookedSeats.map(seat => `${seat.rownum}-${seat.seatnum}`);

        const responseData = {
            id: screening.screeningid,
            movieTitle: screening.movietitle,
            hall: screening.hallname,
            rowsCount: screening.rowscount,
            seatsPerRow: screening.seatsperrow,
            basePrice: parseFloat(screening.baseprice),
            bookedSeatKeys: bookedSeatKeys,

            // Передаем полную дату для сводки, как и в initialSeatData
            startTime: formatDate(screening.starttime.toISOString(), 'DD.MM.YYYY HH:mm'),
        };

        res.json(responseData);

    } catch (e) {
        console.error(`Ошибка при загрузке схемы для сеанса ID ${sessionId}:`, e);
        res.status(500).json({ error: 'Ошибка сервера при загрузке схемы мест.' });
    }
});

router.post('/api/reserve-seats', authMiddleware, async (req, res) => {
    const { screeningId, seatKeys } = req.body;
    const userId = req.session.user.userId;

    if (!screeningId || !seatKeys || !Array.isArray(seatKeys) || seatKeys.length === 0) {
        return res.status(400).json({ error: 'Неверные данные для бронирования' });
    }

    try {
        await pool.query('BEGIN');

        // 1. Проверяем, не заняты ли места
        const seatCheckPromises = seatKeys.map(seatKey => {
            const [row, seat] = seatKey.split('-').map(Number);

            return pool.query(`
                SELECT 1 FROM tickets 
                WHERE screeningid = $1 
                AND rownum = $2 
                AND seatnum = $3 
                AND (
                    status = 'Оплачен' 
                    OR status = 'Бронь'
                    OR (status = 'Забронирован' AND reservationexpiresat > NOW())
                )
            `, [screeningId, row, seat]);
        });

        const seatChecks = await Promise.all(seatCheckPromises);

        // Проверяем, есть ли уже занятые места
        const alreadyBooked = seatChecks.some(result => result.rows.length > 0);

        if (alreadyBooked) {
            await pool.query('ROLLBACK');
            return res.status(409).json({
                error: 'Некоторые места уже забронированы или оплачены'
            });
        }

        // 2. Создаем временные бронирования
        const reservationExpires = new Date(Date.now() + 10 * 60 * 1000); // +10 минут

        for (const seatKey of seatKeys) {
            const [row, seat] = seatKey.split('-').map(Number);
            const qrToken = crypto.randomBytes(16).toString('hex');

            await pool.query(`
                INSERT INTO tickets (
                    userid, screeningid, rownum, seatnum, 
                    status, totalprice, qrtoken, reservationexpiresat
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `, [
                userId,
                screeningId,
                row,
                seat,
                'Забронирован',
                0, // Цена будет обновлена после оплаты
                qrToken,
                reservationExpires
            ]);
        }

        await pool.query('COMMIT');

        res.json({
            success: true,
            message: `Места забронированы на 10 минут`,
            reservationId: crypto.randomBytes(8).toString('hex')
        });

    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('Ошибка при бронировании мест:', error);
        res.status(500).json({ error: 'Ошибка сервера при бронировании' });
    }
});

module.exports = router;