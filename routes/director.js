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

        // Получаем все фильмы режиссера
        const moviesQuery = `
            SELECT
                m.movieid,
                m.title,
                m.posterurl,
                m.releaseyear,
                m.ratingavg as rating,
                m.genre,
                m.durationmin,
                m.agerestriction,
                m.isactive,
                m.onlineenabled
            FROM movies m
            WHERE m.directorid = $1
            ORDER BY 
                m.releaseyear DESC
        `;
        const moviesResult = await db.query(moviesQuery, [directorId]);

        const allMovies = moviesResult.rows;

        // Считаем количество фильмов в каждой категории
        const activeCount = allMovies.filter(m => m.isactive).length;
        const onlineCount = allMovies.filter(m => m.onlineenabled).length;
        const upcomingCount = allMovies.filter(m => !m.isactive && !m.onlineenabled).length;

        const formattedBirthdate = director.birthdate
            ? new Date(director.birthdate).toLocaleDateString('ru-RU', { year: 'numeric', month: 'long', day: 'numeric' })
            : 'Неизвестно';

        res.render('director/director-details', {
            title: `Режиссер: ${director.name}`,
            director: {
                ...director,
                birthdate: formattedBirthdate
            },
            totalMovies: allMovies.length,
            activeCount,
            onlineCount,
            upcomingCount,
            allMovies
        });

    } catch (e) {
        console.error(`Ошибка при загрузке страницы режиссера ID ${directorId}:`, e);
        res.status(500).render('error', {
            title: 'Ошибка сервера',
            error: 'Не удалось загрузить информацию о режиссере.'
        });
    }
});

module.exports = router