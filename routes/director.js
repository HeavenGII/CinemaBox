const { Router } = require('express')
const db = require('../db')
const router = Router()


router.get('/:directorId', async (req, res) => {
    const directorId = req.params.directorId;

    try {
        const directorQuery = `
            SELECT
                directorid,
                name,
                biography,
                birthdate,
                photourl
            FROM directors
            WHERE directorid = $1
        `;
        const directorResult = await db.query(directorQuery, [directorId]);
        const director = directorResult.rows[0];

        if (!director) {
            return res.status(404).render('404', { title: 'Режиссер не найден' });
        }

        const moviesQuery = `
            SELECT
                movieid,
                title,
                posterurl,
                releaseyear,
                ratingavg,
                genre -- <-- ДОБАВЛЕНО: Теперь выбираем жанр
            FROM movies
            WHERE directorid = $1
            ORDER BY releaseyear DESC
        `;
        const moviesResult = await db.query(moviesQuery, [directorId]);

        const movies = moviesResult.rows.map(m => ({
            movieid: m.movieid,
            title: m.title,
            posterurl: m.posterurl,
            releaseyear: m.releaseyear,
            rating: m.ratingavg,
            genre: m.genre
        }));

        const formattedBirthdate = director.birthdate
            ? new Date(director.birthdate).toLocaleDateString('ru-RU', { year: 'numeric', month: 'long', day: 'numeric' })
            : 'Неизвестно';

        res.render('director/director-details', {
            title: `Режиссер: ${director.name}`,
            director: {
                ...director,
                birthdate: formattedBirthdate
            },
            movies
        });

    } catch (e) {
        console.error(`Ошибка при загрузке страницы режиссера ID ${directorId}:`, e);
        res.status(500).render('error', { title: 'Ошибка сервера', error: 'Не удалось загрузить информацию о режиссере.' });
    }
});

module.exports = router
