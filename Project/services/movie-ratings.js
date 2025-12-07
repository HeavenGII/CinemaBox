const axios = require('axios');
const pool = require('../db');


const OMDB_API_BASE_URL = 'http://www.omdbapi.com/';
const OMDB_API_KEY = '45daa9c6';

const YANDEX_IAM_TOKEN = 't1.9euelZqckZuRnJXNlomXkZWblZ2WmO3rnpWanJyQzMeYxo6LjM_HzMaRjJLl8_cuE3E3-e8cZExX_d3z925Bbjf57xxkTFf9zef1656VmsmPys7JioqVipbHm4qQz5GO7_zF656VmsmPys7JioqVipbHm4qQz5GO.qqbnDYq40GRRpnXWdzz-eoGMfNoZzduMWepty-lv-sja3U3Grcwdc9cSZKvR4_nJC2LgyRFPFhdzgmHjtTdBDw';
const YANDEX_FOLDER_ID = 'b1gh9nv97qaqoonjv5po';
const YANDEX_API_URL = 'https://translate.api.cloud.yandex.net/translate/v2/translate';


function containsCyrillic(text) {
    return /[\u0400-\u04FF]/.test(text);
}


function extractMovieTitle(query) {
    if (!query) return 'Неизвестный фильм';
    const match = query.match(/movie["']?s*["']?s*"([^"]+)"|for the movie "([^"]+)"/i);
    if (match) {
        return (match[1] || match[2]).trim();
    }
    return query.trim() || 'Неизвестный фильм';
}


async function getMovieTitlesFromDB(searchTitle) {
    try {
        console.log(`💾 Attempting DB lookup for title pair (Russian/Original)...`);
        const query = `
            SELECT title, originaltitle
            FROM movies 
            WHERE title ILIKE $1 
            LIMIT 1
        `;
        const { rows } = await pool.query(query, [`%${searchTitle}%`]);

        if (rows.length > 0) {
            const result = rows[0];
            const dbTitles = {
                russianTitle: result.title,
                originalEnglishTitle: result.originaltitle || null
            };

            if (dbTitles.originalEnglishTitle) {
                console.log(`✅ DB lookup successful: Found Russian title "${dbTitles.russianTitle}" and Original title "${dbTitles.originalEnglishTitle}"`);
            } else {
                console.log(`⚠️ DB lookup found Russian title "${dbTitles.russianTitle}", but originaltitle is empty. Proceeding to translation fallback.`);
            }
            return dbTitles;
        }

        console.log('❌ DB lookup failed: No matching movie found in the database.');
        return null;
    } catch (error) {
        console.error('❌ DB query error for title lookup:', error.message);
        return null;
    }
}


async function translateTitle(russianTitle) {
    if (!russianTitle || !YANDEX_IAM_TOKEN || !YANDEX_FOLDER_ID) {
        console.error('❌ Yandex IAM token or folder ID are missing. Translation skipped.');
        return null;
    }

    console.log(`🌍 Attempting translation for: "${russianTitle}"`);

    const payload = {
        folderId: YANDEX_FOLDER_ID,
        texts: [russianTitle],
        targetLanguageCode: 'en'
    };

    try {
        const response = await axios.post(
            YANDEX_API_URL,
            payload,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${YANDEX_IAM_TOKEN}`
                },
                timeout: 15000
            }
        );

        const result = response.data;
        const translatedText = result.translations?.[0]?.text?.trim();

        if (translatedText) {
            console.log(`✅ Translation successful: "${russianTitle}" -> "${translatedText}"`);
            return translatedText;
        } else {
            console.error('❌ Translation failed: No translated text returned.');
            console.log('API Response data:', result);
            return null;
        }

    } catch (error) {
        const status = error.response ? error.response.status : 'Network/Timeout';
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;

        console.error(`❌ Translation API error (Status: ${status}): ${errorMessage}`);

        if (status >= 400 && status < 500) {
            console.error('⚠️ Check your Yandex IAM Token and Folder ID.');
        }

        return null;
    }
}


async function searchMovieWithOMDbAPI(title) {
    try {
        console.log(`🔍 Searching with OMDb API for: "${title}"`);

        const response = await axios.get(OMDB_API_BASE_URL, {
            params: {
                t: title,
                apikey: OMDB_API_KEY,
                plot: 'full'
            },
            timeout: 15000
        });

        const movieData = response.data;

        if (movieData.Response === 'False') {
            console.log(`❌ OMDb Error: ${movieData.Error}`);
            return null;
        }

        console.log(`🎬 Found movie: ${movieData.Title} (${movieData.Year})`);

        let imdbRating = 'N/A';
        let rtRating = 'N/A';
        let metacriticRating = 'N/A';

        if (movieData.imdbRating && movieData.imdbRating !== "N/A") {
            imdbRating = `${movieData.imdbRating}/10`;
        }

        if (movieData.Ratings && Array.isArray(movieData.Ratings)) {
            const rtRatingObj = movieData.Ratings.find(r => r.Source === 'Rotten Tomatoes');
            if (rtRatingObj) {
                rtRating = rtRatingObj.Value;
            }

            const mcRatingObj = movieData.Ratings.find(r => r.Source === 'Metacritic');
            if (mcRatingObj) {
                metacriticRating = mcRatingObj.Value;
            }
        }

        return {
            title: movieData.Title,
            year: movieData.Year,
            imdbRating,
            rtRating,
            metacriticRating,
            plot: movieData.Plot || 'Описание недоступно',
            poster: movieData.Poster && movieData.Poster !== 'N/A' ? movieData.Poster : null,
            actors: movieData.Actors || 'N/A',
            director: movieData.Director || 'N/A',
            genre: movieData.Genre || 'N/A'
        };

    } catch (error) {
        console.error('❌ OMDb API error (likely network/timeout):', error.message);
        return null;
    }
}


async function smartMovieSearch(userQueryTitle) {
    const isRussian = containsCyrillic(userQueryTitle);
    let movieData = null;

    if (isRussian) {
        const dbTitles = await getMovieTitlesFromDB(userQueryTitle);

        if (dbTitles) {
            if (dbTitles.originalEnglishTitle) {
                const searchTitleDB = dbTitles.originalEnglishTitle;
                console.log(`🔎 Attempt 1 (DB Original): Searching OMDb for: "${searchTitleDB}"`);

                movieData = await searchMovieWithOMDbAPI(searchTitleDB);

                if (movieData) {
                    movieData.originalRussianTitle = dbTitles.russianTitle;
                    movieData.searchedWithDB = true;
                    return movieData;
                }
            }

            console.log(`🌍 Attempt 2 (DB Translate): Translating DB title "${dbTitles.russianTitle}"...`);
            const translatedTitle = await translateTitle(dbTitles.russianTitle);

            if (translatedTitle) {
                console.log(`🔎 Attempt 2 (DB Translate): Searching OMDb for: "${translatedTitle}"`);
                movieData = await searchMovieWithOMDbAPI(translatedTitle);

                if (movieData) {
                    movieData.originalRussianTitle = dbTitles.russianTitle;
                    movieData.searchedWithTranslation = true;
                    return movieData;
                }
            }
        }
    }

    console.log(`🔎 Final Attempt (Query Direct): Searching OMDb for: "${userQueryTitle}"`);
    movieData = await searchMovieWithOMDbAPI(userQueryTitle);

    if (movieData && isRussian) {
        movieData.originalRussianTitle = userQueryTitle;
    }

    if (movieData) {
        return movieData;
    } else {

        console.log(`⚠️ All search attempts failed for "${userQueryTitle}". Returning 'N/A' data structure.`);

        return {
            title: userQueryTitle,
            year: 'N/A',
            imdbRating: 'N/A',
            rtRating: 'N/A',
            metacriticRating: 'N/A',
            plot: isRussian ? 'Описание фильма недоступно.' : 'Plot not available.',
            poster: null,
            actors: 'N/A',
            director: 'N/A',
            genre: 'N/A',
            originalRussianTitle: isRussian ? userQueryTitle : 'N/A',
            searchedWithDB: false,
            searchedWithTranslation: false,
        };
    }
}

module.exports = {
    extractMovieTitle,
    smartMovieSearch,
    containsCyrillic
};
