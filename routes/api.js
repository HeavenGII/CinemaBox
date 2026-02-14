const { Router } = require('express');
const router = Router();
const pool = require('../db');

const {
    extractMovieTitle,
    smartMovieSearch,
    containsCyrillic
} = require('../services/movie-ratings');

router.post('/ratings', async (req, res) => {
    const userQuery = req.body.query;

    if (!userQuery) {
        return res.status(400).json({ error: 'Missing query parameter (Movie Title).' });
    }

    try {
        const movieTitle = extractMovieTitle(userQuery);
        console.log(`🎯 Processing request for: "${movieTitle}"`);

        const movieData = await smartMovieSearch(movieTitle);

        if (movieData) {
            let ratingsText = '';

            ratingsText += `⭐ **IMDb**: ${movieData.imdbRating}\n`;

            if (movieData.rtRating !== 'N/A') {
                ratingsText += `🍅 **Rotten Tomatoes**: ${movieData.rtRating}\n`;
            }

            if (movieData.metacriticRating !== 'N/A') {
                ratingsText += `📊 **Metacritic**: ${movieData.metacriticRating}\n`;
            }

            return res.json({
                text: ratingsText,
                data: movieData
            });

        } else {
            console.error(`❌ No ratings found for: "${movieTitle}"`);

            let errorMessage = `❌ Не удалось найти рейтинги для "${movieTitle}".\n\n`;

            if (containsCyrillic(movieTitle)) {
                errorMessage += `**Совет**: Проверьте, что фильм "${movieTitle}" внесен в вашу БД с правильным английским названием, или попробуйте точное оригинальное название.`;
            } else {
                errorMessage += `Проверьте правильность написания названия.`;
            }

            return res.status(404).json({
                error: 'Movie not found',
                text: errorMessage
            });
        }

    } catch (error) {
        console.error('💥 Fatal Error in ratings API:', error.message);

        const fallbackTitle = extractMovieTitle(userQuery);
        const fallbackText = `❌ Произошла критическая ошибка при поиске рейтингов для "${fallbackTitle}"`;

        return res.status(500).json({
            text: fallbackText,
            error: error.message
        });
    }
});

router.get('/movie/:id/qualities', async (req, res) => {
    const movieId = req.params.id;

    try {
        const result = await pool.query(
            'SELECT onlineurl, qualities FROM movies WHERE movieid = $1',
            [movieId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Movie not found' });
        }

        const movie = result.rows[0];

        // Если onlineurl не заканчивается на /, добавляем
        let baseUrl = movie.onlineurl;
        if (baseUrl && !baseUrl.endsWith('/')) {
            baseUrl = baseUrl + '/';
        }

        // Убираем / в конце если это папка с ID
        if (baseUrl && baseUrl.match(/\/\d+\/$/)) {
            baseUrl = baseUrl.slice(0, -1);
        }

        // Получаем качества из БД или используем значения по умолчанию
        const qualities = movie.qualities || ['1080p', '720p', '480p', '360p'];

        res.json({
            baseUrl: baseUrl,
            qualities: qualities,
            movieId: movieId
        });

    } catch (error) {
        console.error('Error fetching qualities:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
