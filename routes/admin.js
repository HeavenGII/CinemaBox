const { Router } = require('express');
const { body, validationResult } = require('express-validator');
const router = Router();
const pool = require('../db');
const adminMiddleware = require('../middleware/admin');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { sendAccountBlockedEmail, sendScreeningCancellationEmail } = require('../services/sendEmail');
const { sendAccountBlockedNotification, sendScreeningCancellationNotification } = require('../services/telegram-bot-handler');
const { uploadFile, deleteFile } = require('../services/storage-service');

const CLEANING_TIME_MINUTES = 30;
const CLEANING_TIME_MS = CLEANING_TIME_MINUTES * 60000;

const DAY_START_HOUR = 9;
const LATEST_START_HOUR = 21;

function roundToNearestFiveMinutes(date) {
    const minutes = date.getMinutes();
    const roundedMinutes = Math.round(minutes / 5) * 5;
    if (roundedMinutes === 60) {
        date.setHours(date.getHours() + 1);
        date.setMinutes(0);
    } else {
        date.setMinutes(roundedMinutes);
    }
    date.setSeconds(0, 0);
    return date;
}

router.use(adminMiddleware);


const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = 'public/uploads/posters';
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'poster-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Разрешены только файлы изображений (JPEG, PNG, WebP)!'), false);
        }
    }
}).single('posterFile');

const directorPhotoStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = 'public/uploads/directors';
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'director-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const uploadDirectorPhoto = multer({
    storage: directorPhotoStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Разрешены только файлы изображений (JPEG, PNG, WebP)!'), false);
        }
    }
}).single('directorPhoto');

const shortVideoStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = 'public/uploads/shorts';
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'short-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const uploadShortVideo = multer({
    storage: shortVideoStorage,
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedMimes = ['video/mp4', 'video/mpeg', 'video/quicktime', 'video/x-msvideo'];
        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Разрешены только видеофайлы (MP4, MPEG, MOV, AVI)!'), false);
        }
    }
}).single('shortVideoFile');

const movieValidators = [
    body('title', 'Название фильма (Русское) должно быть от 2 до 100 символов')
        .isLength({min: 2, max: 100}).trim().escape()
        .custom(async (value, {req}) => {
            if (!req.params.movieid) {
                const query = `
                    SELECT movieid FROM movies 
                    WHERE LOWER(title) = LOWER($1) 
                    AND LOWER(originaltitle) = LOWER($2)
                    AND releaseyear = $3
                    AND durationmin = $4
                `;

                const result = await pool.query(query, [
                    value,
                    req.body.originaltitle,
                    req.body.releaseYear,
                    req.body.durationmin
                ]);

                if (result.rows.length > 0) {
                    throw new Error('Фильм с такими параметрами уже существует (название, оригинальное название, год выпуска и продолжительность)');
                }
            }
            return true;
        }),

    body('originaltitle', 'Оригинальное название (Английское) должно быть от 1 до 100 символов')
        .isLength({min: 1, max: 100}).trim().escape()
        .custom(async (value, {req}) => {
            if (req.params.movieid) {
                const query = `
                    SELECT movieid FROM movies 
                    WHERE LOWER(originaltitle) = LOWER($1)
                    AND releaseyear = $2
                    AND durationmin = $3
                    AND movieid != $4
                `;

                const result = await pool.query(query, [
                    value,
                    req.body.releaseYear,
                    req.body.durationmin,
                    req.params.movieid
                ]);

                if (result.rows.length > 0) {
                    throw new Error('Другой фильм с таким оригинальным названием, годом выпуска и продолжительностью уже существует');
                }
            }
            return true;
        }),

    body('description', 'Описание должно быть от 10 до 2000 символов')
        .isLength({min: 10, max: 2000}).trim().escape(),

    body('durationmin', 'Продолжительность должна быть числом от 1 до 360 минут')
        .isInt({min: 1, max: 360}).toInt(),

    body('releaseYear', 'Год выпуска должен быть от 1888 до текущего года')
        .isInt({min: 1888, max: new Date().getFullYear()})
        .isLength({min: 4, max: 4}).toInt(),

    body('price', 'Цена билета должна быть числом от 0 до 10000')
        .isFloat({min: 0, max: 10000}).toFloat(),

    body('directorName', 'Имя режиссера должно быть от 2 до 100 символов')
        .isLength({min: 2, max: 100}).trim().escape(),

    body('genre', 'Жанр должен быть от 2 до 200 символов')
        .optional({checkFalsy: true})
        .isLength({min: 2, max: 200}).trim(),

    body('trailerUrl', 'Ссылка на трейлер должна быть валидным URL')
        .optional({checkFalsy: true})
        .isURL({protocols: ['http', 'https'], require_protocol: true})
        .trim(),

    body('isActive', 'Некорректное значение активности')
        .optional({checkFalsy: true})
        .isIn(['on', 'off']),

    body('agerestriction')
        .exists({checkFalsy: true}).withMessage('Возрастное ограничение обязательно.')
        .isInt({min: 0, max: 18}).withMessage('Возрастное ограничение должно быть числом от 0 до 18.'),
];

async function checkMovieDuplicate(movieData, excludeMovieId = null) {
    const { title, originaltitle, releaseYear, durationmin, directorId } = movieData;

    let query = `
        SELECT movieid, title, originaltitle, releaseyear, durationmin
        FROM movies 
        WHERE LOWER(title) = LOWER($1) 
        AND LOWER(originaltitle) = LOWER($2)
        AND releaseyear = $3
        AND durationmin = $4
    `;

    const params = [title, originaltitle, releaseYear, durationmin];

    if (excludeMovieId) {
        query += ` AND movieid != $5`;
        params.push(excludeMovieId);
    }

    const result = await pool.query(query, params);

    if (result.rows.length > 0) {
        const duplicate = result.rows[0];
        return {
            isDuplicate: true,
            duplicateMovie: duplicate,
            message: `Фильм с такими параметрами уже существует: "${duplicate.title}" (${duplicate.originaltitle}, ${duplicate.releaseyear} год, ${duplicate.durationmin} мин)`
        };
    }

    if (excludeMovieId) {
        const similarQuery = `
            SELECT movieid, title, originaltitle, releaseyear, durationmin
            FROM movies 
            WHERE LOWER(originaltitle) = LOWER($1)
            AND releaseyear = $2
            AND durationmin = $3
            AND movieid != $4
        `;

        const similarResult = await pool.query(similarQuery, [
            originaltitle, releaseYear, durationmin, excludeMovieId
        ]);

        if (similarResult.rows.length > 0) {
            const similar = similarResult.rows[0];
            return {
                isDuplicate: false,
                isSimilar: true,
                similarMovie: similar,
                message: `Внимание: существует похожий фильм "${similar.title}" с таким же оригинальным названием, годом выпуска и продолжительностью`
            };
        }
    }

    return { isDuplicate: false, isSimilar: false };
}

const directorValidators = [
    body('name', 'Имя режиссера должно быть от 2 до 100 символов')
        .isLength({ min: 2, max: 100 }).trim().escape(),

    body('birthdate', 'Дата рождения должна быть в формате ГГГГ-ММ-ДД (YYYY-MM-DD)')
        .optional({ checkFalsy: true })
        .isISO8601().toDate()
        .custom(value => {
            if (value > new Date()) {
                throw new Error('Дата рождения не может быть в будущем');
            }
            return true;
        }),

    body('biography', 'Биография должна быть от 10 до 5000 символов')
        .isLength({ min: 10, max: 5000 }).trim().escape()
];

const sessionValidators = [
    body('movieId', 'Необходимо выбрать фильм').isInt().toInt(),
    body('hallId', 'Необходимо выбрать зал').isInt().toInt(),
    body('startTime', 'Некорректная дата и время').isISO8601()
];

const shortVideoValidators = [
    body('movieId', 'Необходимо выбрать фильм').isInt().toInt(),

    body('title', 'Заголовок видео должен быть от 2 до 100 символов')
        .isLength({ min: 2, max: 100 }).trim().escape(),

    body('durationsec', 'Длительность видео должна быть от 1 до 180 секунд')
        .isInt({ min: 1, max: 180 }).toInt()
        .withMessage('Длительность видео должна быть от 1 до 180 секунд'),

    body('description', 'Описание видео должно быть от 10 до 1000 символов')
        .optional({ checkFalsy: true })
        .isLength({ min: 10, max: 1000 }).trim().escape()
];

const deleteUserValidators = [
    body('userId', 'Некорректный ID пользователя')
        .isInt().toInt()
        .custom(async (value, { req }) => {
            if (String(value) === String(req.session.user.userid)) {
                throw new Error('Невозможно удалить собственный аккаунт через панель управления');
            }

            const result = await pool.query(
                'SELECT userid, role FROM users WHERE userid = $1',
                [value]
            );

            if (result.rows.length === 0) {
                throw new Error('Пользователь не найден');
            }

            if (result.rows[0].role !== 'Пользователь') {
                throw new Error('Можно удалять только пользователей с ролью "Пользователь"');
            }

            return true;
        })
];


function validateFileUpload(req, fileFieldName) {
    return function(req, res, next) {
        if (!req.file) {
            const fieldMap = {
                'posterFile': 'постер фильма',
                'directorPhoto': 'фото режиссера',
                'shortVideoFile': 'видеофайл'
            };

            const fieldName = fieldMap[fileFieldName] || 'файл';
            return res.status(422).json({
                error: `Необходимо загрузить ${fieldName}`
            });
        }

        const file = req.file;
        const fileTypeError = validateFileType(file, fileFieldName);
        if (fileTypeError) {
            fs.unlink(file.path, (err) => {
                if (err) console.error('Ошибка удаления файла:', err);
            });
            return res.status(422).json({ error: fileTypeError });
        }

        next();
    };
}

function validateFileType(file, fieldName) {
    const imageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    const videoTypes = ['video/mp4', 'video/mpeg', 'video/quicktime', 'video/x-msvideo'];

    if (fieldName === 'shortVideoFile') {
        if (!videoTypes.includes(file.mimetype)) {
            return 'Разрешены только видеофайлы (MP4, MPEG, MOV, AVI)';
        }
    } else {
        if (!imageTypes.includes(file.mimetype)) {
            return 'Разрешены только файлы изображений (JPEG, PNG, WebP)';
        }
    }

    const maxSize = fieldName === 'shortVideoFile' ? 20 * 1024 * 1024 : 5 * 1024 * 1024;
    if (file.size > maxSize) {
        return `Максимальный размер файла: ${maxSize / (1024 * 1024)}MB`;
    }

    return null;
}

router.get('/add',adminMiddleware, (req, res) => {
    res.render('admin/add', {
        title: 'Добавить новый фильм',
        movieData: req.flash('movieData')[0] || {},
        error: req.flash('error'),
        success: req.flash('success')
    });
});

router.post('/add', adminMiddleware,
    (req, res, next) => {
        upload(req, res, (err) => {
            if (err) {
                const errorMessage = err instanceof multer.MulterError ?
                    `Ошибка загрузки постера: ${err.message}. Макс. размер 5MB.` :
                    `Ошибка файла: ${err.message}`;
                req.flash('error', errorMessage);
                req.flash('movieData', req.body);
                return res.redirect('/admin/add');
            }

            if (!req.file) {
                req.flash('error', 'Постер фильма обязателен для добавления');
                req.flash('movieData', req.body);
                return res.redirect('/admin/add');
            }

            next();
        });
    },
    movieValidators,
    async (req, res) => {
        const errors = validationResult(req);

        if (!errors.isEmpty()) {
            if (req.file && req.file.path) {
                fs.unlink(req.file.path, (err) => {
                    if (err) console.error('Ошибка удаления файла:', err);
                });
            }

            const firstError = errors.array()[0];
            req.flash('error', firstError.msg);
            req.flash('movieData', req.body);
            return res.status(422).redirect('/admin/add');
        }

        const tempPath = req.file.path;
        let finalPosterUrl = null;

        let {
            title, originaltitle, description, durationmin, genre, trailerUrl,
            releaseYear, directorName, price, isActive, agerestriction
        } = req.body;

        if (genre) {
            genre = genre
                .split(',')
                .map(g => g.trim().toLowerCase())
                .filter(g => g.length > 0)
                .join(', ');
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const duplicateCheck = await checkMovieDuplicate({
                title: title,
                originaltitle: originaltitle,
                releaseYear: releaseYear,
                durationmin: durationmin
            });

            if (duplicateCheck.isDuplicate) {
                throw new Error(duplicateCheck.message);
            }

            if (duplicateCheck.isSimilar) {
                console.warn('⚠️ Предупреждение о похожем фильме:', duplicateCheck.message);
            }

            let directorId;
            let directorResult = await client.query(
                'SELECT directorid FROM directors WHERE LOWER(name) = LOWER($1)',
                [directorName]
            );

            if (directorResult.rows.length > 0) {
                directorId = directorResult.rows[0].directorid;
            } else {
                if (directorName.length < 2 || directorName.length > 100) {
                    throw new Error('Имя режиссера должно быть от 2 до 100 символов');
                }

                directorResult = await client.query(
                    'INSERT INTO directors (name) VALUES ($1) RETURNING directorid',
                    [directorName]
                );
                directorId = directorResult.rows[0].directorid;
            }

            if (req.file) {
                const destinationKey = `posters/${req.file.filename}`;
                finalPosterUrl = await uploadFile(tempPath, destinationKey);
            }

            const insertQuery = `
                INSERT INTO movies (title, originaltitle, description, durationmin,
                    genre, posterurl, trailerurl, releaseyear, directorid, price, agerestriction)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING movieid;
            `;

            await client.query(insertQuery, [
                title, originaltitle, description, durationmin, genre, finalPosterUrl, trailerUrl,
                releaseYear, directorId, price, agerestriction
            ]);

            await client.query('COMMIT');

            fs.unlink(tempPath, (err) => {
                if (err) console.error('Ошибка удаления временного файла постера после загрузки в облако:', err);
            });


            req.flash('success', `Фильм "${title}" успешно добавлен.`);
            res.redirect('/admin/add');

        } catch (e) {
            await client.query('ROLLBACK');
            console.error('Ошибка добавления фильма:', e);

            if (req.file && req.file.path) {
                fs.unlink(req.file.path, (err) => {
                    if (err) console.error('Ошибка удаления файла:', err);
                });
            }

            const errorMessage = e.code === '23505' ?
                'Фильм с таким названием уже существует' :
                (e.message || 'Произошла ошибка сервера при добавлении фильма.');

            req.flash('error', errorMessage);
            req.flash('movieData', req.body);
            res.redirect('/admin/add');
        } finally {
            client.release();
        }
    }
);

// GET /:movieid/edit - Рендер страницы редактирования
router.get('/movies/:movieid/edit', adminMiddleware,async (req, res) => {
    const movieId = req.params.movieid;

    if (!movieId || isNaN(parseInt(movieId))) {
        req.flash('error', 'Некорректный ID фильма');
        return res.redirect('/');
    }

    try {
        const movieQuery = `
            SELECT 
                m.*,
                d.name AS directorname
            FROM movies m
            JOIN directors d ON m.directorid = d.directorid
            WHERE m.movieid = $1;
        `;
        const result = await pool.query(movieQuery, [movieId]);

        if (result.rows.length === 0) {
            req.flash('error', `Фильм с ID ${movieId} не найден.`);
            return res.redirect('/');
        }

        const movieData = result.rows[0];

        if (movieData.price) {
            movieData.price = parseFloat(movieData.price);
        }

        const flashedData = req.flash('movieData')[0];

        res.render('admin/edit', {
            title: `Редактировать фильм: ${movieData.title}`,
            isEdit: true,
            movieData: flashedData || movieData,
            error: req.flash('error'),
            success: req.flash('success')
        });

    } catch (e) {
        console.error('Ошибка получения данных фильма для редактирования:', e);
        req.flash('error', 'Ошибка сервера при загрузке данных фильма.');
        res.redirect('/');
    }
});

// POST /admin/movies/:movieid/edit - Обработка формы редактирования
router.post('/movies/:movieid/edit', adminMiddleware,
    (req, res, next) => {
        const movieId = req.params.movieid;

        if (!movieId || isNaN(parseInt(movieId))) {
            req.flash('error', 'Некорректный ID фильма');
            return res.redirect('/');
        }

        const redirectUrl = `/admin/movies/${movieId}/edit`;

        upload(req, res, (err) => {
            if (err) {
                const errorMessage = err instanceof multer.MulterError ?
                    `Ошибка загрузки постера: ${err.message}. Макс. размер 5MB.` :
                    `Ошибка файла: ${err.message}`;
                req.flash('error', errorMessage);
                req.flash('movieData', req.body);
                return res.redirect(redirectUrl);
            }
            next();
        });
    },
    movieValidators,
    async (req, res) => {
        const movieId = req.params.movieid;
        const redirectUrl = `/admin/movies/${movieId}/edit`;

        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            if (req.file && req.file.path) {
                fs.unlink(req.file.path, (err) => {
                    if (err) console.error('Не удалось удалить загруженный постер после ошибки валидации:', err);
                });
            }

            req.flash('error', errors.array()[0].msg);
            req.flash('movieData', req.body);
            return res.status(422).redirect(redirectUrl);
        }

        const {
            title, originaltitle, description, durationmin, genre,
            trailerUrl, releaseYear, directorName, price, isActive, agerestriction
        } = req.body;

        let newPosterUrl = null;
        let oldPosterPath = null;
        let tempPath = null;

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            if (req.file) {
                tempPath = req.file.path;
                const destinationKey = `posters/${req.file.filename}`;
                newPosterUrl = await uploadFile(tempPath, destinationKey);
            }

            const movieCheck = await client.query(
                'SELECT movieid, title FROM movies WHERE movieid = $1',
                [movieId]
            );

            if (movieCheck.rows.length === 0) {
                throw new Error('Фильм не найден');
            }

            const originalMovieTitle = movieCheck.rows[0].title;

            const duplicateCheck = await checkMovieDuplicate({
                title: title,
                originaltitle: originaltitle,
                releaseYear: releaseYear,
                durationmin: durationmin
            }, movieId);

            if (duplicateCheck.isDuplicate) {
                throw new Error(duplicateCheck.message);
            }

            if (duplicateCheck.isSimilar) {
                req.flash('warning', duplicateCheck.message);
            }

            if (newPosterUrl) {
                const oldMovieResult = await client.query(
                    'SELECT posterurl FROM movies WHERE movieid = $1',
                    [movieId]
                );
                if (oldMovieResult.rows.length > 0) {
                    oldPosterPath = oldMovieResult.rows[0].posterurl;
                }
            }

            let directorId;
            let directorResult = await client.query(
                'SELECT directorid FROM directors WHERE LOWER(name) = LOWER($1)',
                [directorName]
            );

            if (directorResult.rows.length > 0) {
                directorId = directorResult.rows[0].directorid;
            } else {
                if (directorName.length < 2 || directorName.length > 100) {
                    throw new Error('Имя режиссера должно быть от 2 до 100 символов');
                }

                directorResult = await client.query(
                    'INSERT INTO directors (name) VALUES ($1) RETURNING directorid',
                    [directorName]
                );
                directorId = directorResult.rows[0].directorid;
            }

            const updateQuery = `
                UPDATE movies 
                SET title = $1, originaltitle = $2, description = $3, durationmin = $4, genre = $5, 
                    posterurl = COALESCE($6, posterurl), trailerurl = $7, releaseyear = $8, 
                    directorid = $9, isactive = $10, price = $11, agerestriction = $12
                WHERE movieid = $13
                RETURNING title;
            `;

            await client.query(updateQuery, [
                title, originaltitle, description, durationmin, genre, newPosterUrl, trailerUrl,
                releaseYear, directorId, isActive === 'on', price, agerestriction, movieId
            ]);

            if (newPosterUrl && oldPosterPath) {
                deleteFile(oldPosterPath)
                    .catch(e => console.error('Не удалось удалить старый постер через сервис хранения:', e));
            }

            await client.query('COMMIT');

            if (tempPath) {
                fs.unlink(tempPath, (err) => {
                    if (err) console.error('Не удалось удалить временный файл после загрузки в облако:', err);
                });
            }


            const successMessage = `Фильм "${originalMovieTitle}" успешно обновлен на "${title}".`;

            const warning = req.flash('warning')[0];
            if (warning) {
                req.flash('success', `${successMessage} Внимание: ${warning}`);
            } else {
                req.flash('success', successMessage);
            }

            res.redirect(redirectUrl);

        } catch (e) {
            await client.query('ROLLBACK');
            console.error('Ошибка обновления фильма:', e);

            if (req.file && req.file.path) {
                fs.unlink(req.file.path, (err) => {
                    if (err) console.error('Не удалось удалить загруженный файл после ошибки БД:', err);
                });
            }

            const errorMessage = e.code === '23505' ?
                'Фильм с таким названием уже существует' :
                (e.message || 'Произошла ошибка сервера при обновлении фильма.');

            req.flash('error', errorMessage);
            req.flash('movieData', req.body);
            res.redirect(redirectUrl);
        } finally {
            client.release();
        }
    });

// POST /admin/movies/:movieid/delete - Маршрут для удаления
router.post('/movies/:movieid/delete', adminMiddleware, async (req, res) => {
    const movieId = req.params.movieid;

    if (!movieId || isNaN(parseInt(movieId))) {
        req.flash('error', 'Некорректный ID фильма');
        return res.redirect('/');
    }

    try {
        const movieResult = await pool.query(
            'SELECT posterurl FROM movies WHERE movieid = $1',
            [movieId]
        );

        if (movieResult.rows.length === 0) {
            req.flash('error', 'Фильм для удаления не найден.');
            return res.redirect('/');
        }

        const posterUrl = movieResult.rows[0].posterurl;

        const activeScreenings = await pool.query(
            `SELECT COUNT(*) FROM screenings WHERE movieid = $1 AND starttime >= NOW() AND iscancelled = FALSE`,
            [movieId]
        );
        if (parseInt(activeScreenings.rows[0].count) > 0) {
            req.flash('error', 'Нельзя удалить фильм, на который есть активные сеансы');
            return res.redirect(`/admin/movies/${movieId}/edit`);
        }

        await pool.query('DELETE FROM reviews WHERE movieid = $1', [movieId]);

        const shortsResult = await pool.query(
            'SELECT videopath FROM shorts WHERE movieid = $1',
            [movieId]
        );
        for (const short of shortsResult.rows) {
            if (short.videopath) {
                deleteFile(short.videopath)
                    .catch(e => console.error('Не удалось удалить видео файл через сервис хранения:', e));
            }
        }
        await pool.query('DELETE FROM shorts WHERE movieid = $1', [movieId]);

        await pool.query('DELETE FROM movies WHERE movieid = $1', [movieId]);

        if (posterUrl) {
            deleteFile(posterUrl)
                .catch(e => console.error('Не удалось удалить постер через сервис хранения:', e));
        }

        req.flash('success', `Фильм успешно удален.`);
        res.redirect('/');

    } catch (e) {
        console.error('Ошибка удаления фильма:', e);
        req.flash('error', 'Произошла ошибка сервера при удалении фильма.');
        res.redirect('/');
    }
});

async function getRegularUsers(searchNickname) {
    let query = `
        SELECT 
            userid, 
            email, 
            firstname, 
            lastname, 
            phone, 
            role,
            nickname
            FROM users
        WHERE role = 'Пользователь'
    `;
    const params = [];

    if (searchNickname) {
        query += ` AND nickname ILIKE $1`;
        params.push(`%${searchNickname}%`);
    }

    const result = await pool.query(query, params);
    return result.rows;
}

// GET /admin/users - Страница управления пользователями
router.get('/users', adminMiddleware, async (req, res) => {
    const searchNickname = req.query.searchNickname ? req.query.searchNickname.trim() : null;

    if (searchNickname && searchNickname.length < 2) {
        req.flash('error', 'Введите корректный nickname для поиска (минимум 2 символа)');
        return res.redirect('/admin/users');
    }

    const errorMessages = req.flash('error');
    const successMessages = req.flash('success');

    try {
        const users = await getRegularUsers(searchNickname);

        res.render('admin/users', {
            title: 'Управление пользователями',
            isAdminPage: true,
            users: users,
            user: req.session.user,
            searchNickname: searchNickname,
            error: errorMessages.length > 0 ? errorMessages[0] : null,
            success: successMessages.length > 0 ? successMessages[0] : null
        });

    } catch (e) {
        console.error('Ошибка при загрузке списка пользователей:', e);
        req.flash('error', 'Не удалось загрузить список пользователей.');
        res.redirect('/');
    }
});

// POST /admin/users/delete - Удаление пользователя
router.post('/users/delete', adminMiddleware,
    deleteUserValidators,
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            req.flash('error', errors.array()[0].msg);
            return res.redirect('/admin/users');
        }

        const userIdToDelete = req.body.userId;
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const userResult = await client.query(
                'SELECT email, firstname, lastname, nickname, telegramid FROM users WHERE userid = $1',
                [userIdToDelete]
            );

            if (userResult.rows.length === 0) {
                throw new Error('Пользователь не найден');
            }

            const userData = userResult.rows[0];
            const userEmail = userData.email;
            const userName = userData.firstname || userData.nickname || 'Пользователь';
            const userTelegramId = userData.telegramid;

            const futureTicketsQuery = `
                SELECT 
                    t.ticketid,
                    t.totalprice,
                    t.qrtoken,
                    s.starttime,
                    m.title as movie_title,
                    pm.payment_id,
                    pm.yookassa_payment_id,
                    pm.amount,
                    pm.currency,
                    u.email as user_email
                FROM tickets t
                JOIN screenings s ON t.screeningid = s.screeningid
                JOIN movies m ON s.movieid = m.movieid
                JOIN payment_metadata pm ON t.qrtoken = pm.ticket_token
                JOIN users u ON t.userid = u.userid
                WHERE t.userid = $1 
                AND t.status = 'Оплачен'
                AND s.starttime > NOW()  -- ТОЛЬКО БУДУЩИЕ СЕАНСЫ
                AND pm.yookassa_payment_id IS NOT NULL
                AND pm.yookassa_payment_id != '';
            `;

            const { rows: futureTickets } = await client.query(futureTicketsQuery, [userIdToDelete]);

            let refundCount = 0;
            const refundedTicketsInfo = [];
            let totalRefund = 0;

            for (const ticket of futureTickets) {
                await client.query(`
                    UPDATE tickets
                    SET status = 'Возвращен',
                        refundedat = CURRENT_TIMESTAMP
                    WHERE ticketid = $1
                `, [ticket.ticketid]);

                const simulatedRefundId = `admin_userdel_rf_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

                let amountInRub;
                if (ticket.amount && !isNaN(parseFloat(ticket.amount))) {
                    amountInRub = parseFloat(ticket.amount);
                } else if (ticket.totalprice && !isNaN(parseFloat(ticket.totalprice))) {
                    amountInRub = parseFloat(ticket.totalprice);
                } else {
                    amountInRub = 0;
                }

                totalRefund += amountInRub;

                await client.query(`
                    INSERT INTO refunds (
                        ticket_id,
                        payment_id,
                        refund_id,
                        amount,
                        currency,
                        status,
                        reason,
                        yookassa_payment_id,
                        is_simulated
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
                `, [
                    ticket.ticketid,
                    ticket.payment_id,
                    simulatedRefundId,
                    amountInRub,
                    ticket.currency || 'BYN',
                    'succeeded',
                    `Возврат из-за удаления аккаунта администратором (пользователь: ${ticket.user_email})`,
                    ticket.yookassa_payment_id
                ]);

                refundCount++;

                refundedTicketsInfo.push({
                    movieTitle: ticket.movie_title,
                    startTime: new Date(ticket.starttime).toLocaleString('ru-RU'),
                    amount: amountInRub
                });

                console.log(`✅ Админ: возврат для билета ${ticket.ticketid} (фильм: ${ticket.movie_title}): ${simulatedRefundId}, сумма: ${amountInRub} руб.`);
            }

            const pastTicketsQuery = `
                SELECT t.ticketid, s.starttime, m.title as movie_title
                FROM tickets t
                JOIN screenings s ON t.screeningid = s.screeningid
                JOIN movies m ON s.movieid = m.movieid
                WHERE t.userid = $1 
                AND t.status = 'Оплачен'
                AND s.starttime <= NOW();
            `;

            const { rows: pastTickets } = await client.query(pastTicketsQuery, [userIdToDelete]);

            for (const ticket of pastTickets) {
                await client.query(`
                    UPDATE tickets
                    SET status = 'Административно аннулирован',
                        refundedat = CURRENT_TIMESTAMP
                    WHERE ticketid = $1
                `, [ticket.ticketid]);

                console.log(`ℹ️ Админ: билет ${ticket.ticketid} на прошедший сеанс "${ticket.movie_title}" помечен как аннулированный`);
            }

            await client.query(`
                DELETE FROM user_sessions WHERE sess->'user'->>'userid' = $1;
            `, [userIdToDelete]);

            await client.query('DELETE FROM reviews WHERE userid = $1', [userIdToDelete]);

            await client.query('DELETE FROM ratings WHERE userid = $1', [userIdToDelete]);

            await client.query('UPDATE tickets SET userid = NULL WHERE userid = $1', [userIdToDelete]);

            await client.query('UPDATE payment_metadata SET user_id = NULL WHERE user_id = $1', [userIdToDelete]);

            const deleteQuery = 'DELETE FROM users WHERE userid = $1';
            const result = await client.query(deleteQuery, [userIdToDelete]);

            await client.query('COMMIT');

            let emailSent = false;
            let telegramSent = false;

            if (userEmail) {
                try {
                    console.log('\n📧 Пытаюсь отправить Email уведомление...');
                    const emailResult = await sendAccountBlockedEmail(
                        userEmail,
                        userName,
                        refundedTicketsInfo,
                        refundCount
                    );

                    if (emailResult && emailResult.messageId) {
                        emailSent = true;
                        console.log('✅ Email отправлен успешно! Message ID:', emailResult.messageId);
                        console.log(`📧 Email уведомление об удалении аккаунта отправлено на ${userEmail}`);
                    } else {
                        console.log('⚠️ Email отправлен, но не получен confirmation');
                    }
                } catch (emailError) {
                    console.error('❌ Ошибка отправки email уведомления:', emailError.message);
                    console.error('Полная ошибка:', emailError);
                }
            } else {
                console.log('❌ Email не отправлен. Причина: email отсутствует у пользователя');
            }

            if (userTelegramId) {
                try {
                    console.log('\n📱 Пытаюсь отправить Telegram уведомление...');
                    console.log('- Telegram ID:', userTelegramId);
                    console.log('- Данные о возвратах:', refundedTicketsInfo);
                    console.log('- Общая сумма:', totalRefund);

                    const telegramResult = await sendAccountBlockedNotification(
                        userTelegramId,
                        userName,
                        refundedTicketsInfo,
                        totalRefund
                    );

                    console.log('Результат отправки Telegram:', telegramResult);

                    if (telegramResult === true) {
                        telegramSent = true;
                        console.log('✅ Telegram уведомление успешно отправлено!');
                        console.log(`📱 Telegram уведомление об удалении аккаунта отправлено пользователю ${userTelegramId}`);
                    } else {
                        console.log('❌ Telegram уведомление НЕ отправлено (возвращено false)');
                    }
                } catch (telegramError) {
                    console.error('❌ Ошибка отправки Telegram уведомления:', telegramError.message);
                    console.error('Полная ошибка Telegram:', telegramError);
                }
            } else {
                console.log('\n❌ Telegram не отправлен. Причина: Telegram ID отсутствует у пользователя');
            }

            console.log('\n=== СТАТУС ОТПРАВКИ ===');
            console.log('- Email отправлен:', emailSent);
            console.log('- Telegram отправлен:', telegramSent);

            if (result.rowCount > 0) {
                let message = `Пользователь ID: ${userIdToDelete} успешно удален.`;

                if (refundCount > 0) {
                    message += ` Автоматически возвращено ${refundCount} билетов на будущие сеансы.`;

                    const notificationStatus = [];
                    if (emailSent) notificationStatus.push('email');
                    if (telegramSent) notificationStatus.push('telegram');

                    if (notificationStatus.length > 0) {
                        message += ` Отправлены уведомления через: ${notificationStatus.join(', ')}.`;
                    }
                }

                if (pastTickets.length > 0) {
                    message += ` ${pastTickets.length} билетов на прошедшие сеансы аннулированы.`;
                }

                req.flash('success', message);
            } else {
                req.flash('error', `Пользователь с ID: ${userIdToDelete} не найден.`);
            }

        } catch (e) {
            await client.query('ROLLBACK');
            console.error('❌ Ошибка при удалении пользователя:', e);
            req.flash('error', 'Произошла ошибка базы данных при удалении пользователя.');
        } finally {
            client.release();
        }

        res.redirect('/admin/users');
    }
);

// POST /admin/reviews/:reviewid/delete - Удаление отзыва администратором
router.post('/reviews/:reviewid/delete', adminMiddleware,
    async (req, res) => {
        const reviewId = req.params.reviewid;
        const referer = req.header('Referer') || '/';
        const { reason } = req.body;

        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            req.flash('error', errors.array()[0].msg);
            return res.redirect(referer);
        }

        if (!reviewId || isNaN(parseInt(reviewId))) {
            req.flash('error', 'Неверный ID отзыва.');
            return res.redirect(referer);
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const reviewQuery = 'SELECT userid, movieid FROM reviews WHERE reviewid = $1';
            const reviewResult = await client.query(reviewQuery, [reviewId]);

            if (reviewResult.rows.length === 0) {
                await client.query('ROLLBACK');
                req.flash('error', `Отзыв с ID: ${reviewId} не найден.`);
                return res.redirect(referer);
            }

            const { userid, movieid } = reviewResult.rows[0];

            await client.query('DELETE FROM reviews WHERE reviewid = $1', [reviewId]);
            await client.query('DELETE FROM ratings WHERE movieid = $1 AND userid = $2', [movieid, userid]);

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
            await client.query(updateRatingQuery, [movieid]);

            await client.query('COMMIT');

            console.log(`Администратор ${req.session.user.userid} удалил отзыв ${reviewId} пользователя ${userid}. Причина: ${reason || 'не указана'}`);

            req.flash('success', `Отзыв ID: ${reviewId} успешно удален. Рейтинг фильма обновлен.`);

        } catch (e) {
            await client.query('ROLLBACK');
            console.error('Ошибка при удалении отзыва администратором:', e);
            req.flash('error', 'Произошла ошибка сервера при удалении отзыва.');
        } finally {
            client.release();
        }

        res.redirect(referer);
    }
);

// GET /admin/edit-director/:directorid? - Рендер страницы добавления/редактирования режиссера
router.get('/edit-director/:directorid?', adminMiddleware, async (req, res) => {
    const directorId = req.params.directorid;
    const redirectUrl = '/admin/edit-director';

    if (directorId && (!directorId || isNaN(parseInt(directorId)))) {
        req.flash('error', 'Некорректный ID режиссера');
        return res.redirect(redirectUrl);
    }

    let directorData = req.flash('directorData')[0] || {};
    const isEdit = !!directorId;

    if (isEdit && !req.flash('directorData')[0]) {
        try {
            const result = await pool.query(
                'SELECT directorid, name, biography, birthdate, photourl FROM directors WHERE directorid = $1',
                [directorId]
            );

            if (result.rows.length === 0) {
                req.flash('error', 'Режиссер не найден.');
                return res.redirect(redirectUrl);
            }
            directorData = result.rows[0];

            if (directorData.birthdate) {
                directorData.birthdate = new Date(directorData.birthdate).toISOString().split('T')[0];
            }

        } catch (e) {
            console.error('Ошибка получения данных режиссера:', e);
            req.flash('error', 'Ошибка сервера при загрузке данных режиссера.');
            return res.redirect(redirectUrl);
        }
    }

    res.render('admin/edit-director', {
        title: isEdit ? `Редактировать режиссера: ${directorData.name}` : 'Добавить нового режиссера',
        isEdit: isEdit,
        director: directorData,
        error: req.flash('error'),
        success: req.flash('success')
    });
});

// 1. POST /admin/edit-director/:directorid? - Обработка формы добавления/редактирования режиссера
router.post('/edit-director/:directorid?', adminMiddleware,
    (req, res, next) => {
        let directorId = req.params.directorid;
        const redirectUrl = directorId ? `/admin/edit-director/${directorId}` : '/admin/edit-director';

        uploadDirectorPhoto(req, res, (err) => {
            if (err) {
                const errorMessage = err instanceof multer.MulterError ?
                    `Ошибка загрузки фото: ${err.message}. Макс. размер 5MB.` :
                    `Ошибка файла: ${err.message}`;
                req.flash('error', errorMessage);
                req.flash('directorData', req.body);
                return res.redirect(redirectUrl);
            }
            next();
        });
    },
    directorValidators,
    async (req, res) => {
        let directorId = req.params.directorid;
        const isEdit = !!directorId;
        const redirectUrl = isEdit ? `/admin/edit-director/${directorId}` : '/admin/edit-director';

        const errors = validationResult(req);

        if (!errors.isEmpty()) {
            if (req.file && req.file.path) {
                fs.unlink(req.file.path, (err) => {
                    if (err) console.error('Не удалось удалить загруженное фото после ошибки валидации:', err);
                });
            }
            req.flash('error', errors.array()[0].msg);
            req.flash('directorData', req.body);
            return res.status(422).redirect(redirectUrl);
        }

        const { name, birthdate, biography, currentPhotourl } = req.body;

        if (!isEdit && !req.file) {
            req.flash('error', 'Для добавления нового режиссера необходимо загрузить фото.');
            req.flash('directorData', req.body);
            return res.redirect(redirectUrl);
        }

        let newPhotoUrl = null;
        let oldPhotoPath = null;
        let tempPath = null;

        try {
            if (req.file) {
                tempPath = req.file.path;
                const destinationKey = `directors/${req.file.filename}`;
                newPhotoUrl = await uploadFile(tempPath, destinationKey);
            }

            if (isEdit) {
                const directorCheck = await pool.query(
                    'SELECT directorid FROM directors WHERE directorid = $1',
                    [directorId]
                );
                if (directorCheck.rows.length === 0) {
                    req.flash('error', 'Режиссер не найден');
                    return res.redirect('/');
                }

                if (newPhotoUrl) {
                    const oldDirectorResult = await pool.query(
                        'SELECT photourl FROM directors WHERE directorid = $1',
                        [directorId]
                    );
                    if (oldDirectorResult.rows.length > 0) {
                        oldPhotoPath = oldDirectorResult.rows[0].photourl;
                    }
                }

                const updateQuery = `
                    UPDATE directors 
                    SET name = $1, biography = $2, birthdate = $3, photourl = COALESCE($4, photourl) 
                    WHERE directorid = $5
                `;
                await pool.query(updateQuery, [name, biography, birthdate || null, newPhotoUrl, directorId]);

                if (newPhotoUrl && oldPhotoPath) {
                    deleteFile(oldPhotoPath)
                        .catch(e => console.error('Не удалось удалить старое фото режиссера через сервис хранения:', e));
                }

                req.flash('success', `Режиссер ${name} успешно обновлен.`);

            } else {
                const insertQuery = `
                    INSERT INTO directors (name, birthdate, biography, photourl)
                    VALUES ($1, $2, $3, $4) RETURNING directorid;
                `;
                const result = await pool.query(insertQuery, [name, birthdate || null, biography, newPhotoUrl]);
                directorId = result.rows[0].directorid;
                req.flash('success', `Режиссер ${name} успешно добавлен.`);
            }

            if (tempPath) {
                fs.unlink(tempPath, (err) => {
                    if (err) console.error('Не удалось удалить временный файл фото режиссера после загрузки в облако:', err);
                });
            }

            res.redirect(redirectUrl);

        } catch (e) {
            console.error('Ошибка добавления/обновления режиссера:', e);

            if (req.file && req.file.path) {
                fs.unlink(req.file.path, (err) => {
                    if (err) console.error('Не удалось удалить загруженное фото после ошибки БД:', err);
                });
            }

            req.flash('error', e.message || 'Произошла ошибка сервера при обработке режиссера.');
            req.flash('directorData', req.body);
            res.redirect(redirectUrl);
        }
    }
);

// 2. POST /admin/delete-director/:directorid - Удаление режиссера
router.post('/delete-director/:directorid', adminMiddleware, async (req, res) => {
    const directorId = req.params.directorid;

    if (!directorId || isNaN(parseInt(directorId))) {
        req.flash('error', 'Некорректный ID режиссера');
        return res.redirect('/admin/directors');
    }

    const redirectUrl = `/director/${directorId}`;

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const directorResult = await client.query(
            'SELECT photourl FROM directors WHERE directorid = $1',
            [directorId]
        );

        if (directorResult.rows.length === 0) {
            await client.query('ROLLBACK');
            req.flash('error', 'Режиссер для архивации не найден.');
            return res.redirect(redirectUrl);
        }

        const photoUrl = directorResult.rows[0].photourl;


        await client.query(`
            UPDATE directors
            SET biography = NULL,
                birthdate = NULL,
                photourl = NULL
            WHERE directorid = $1
        `, [directorId]);


        await client.query(`
            UPDATE movies
            SET directorid = NULL
            WHERE directorid = $1
        `, [directorId]);


        await client.query('COMMIT');


        if (photoUrl && !photoUrl.startsWith('http')) {
            const absolutePath = path.join(__dirname, '..', 'public', photoUrl);
            fs.unlink(absolutePath, (err) => {
                if (err) {
                    console.error(`Не удалось удалить фото режиссера по пути ${absolutePath}:`, err);
                } else {
                    console.log(`✅ Фото режиссера успешно удалено: ${photoUrl}`);
                }
            });
        }

        res.redirect(redirectUrl);

    } catch (e) {
        await client.query('ROLLBACK');
        console.error('❌ Ошибка архивации режиссера:', e);
        req.flash('error', 'Произошла критическая ошибка сервера при архивации режиссера.');
        res.redirect(redirectUrl);
    } finally {
        client.release();
    }
});

// GET /admin/sessions - Отображение списка сеансов и формы добавления
router.get('/sessions', adminMiddleware, async (req, res) => {
    try {
        const moviesQuery = `
            SELECT movieid, title, price, durationmin
            FROM movies 
            WHERE isactive = TRUE
            ORDER BY title;
        `;
        const { rows: movies } = await pool.query(moviesQuery);

        const hallsQuery = `
            SELECT hallid, name, rowscount, seatsperrow 
            FROM halls 
            ORDER BY hallid;
        `;
        const { rows: halls } = await pool.query(hallsQuery);

        const upcomingScreeningsQuery = `
            SELECT
                s.screeningid,
                s.starttime,
                m.title AS movieTitle,
                h.name AS hallName,
                s.iscancelled,
                m.durationmin,
                COUNT(t.ticketid) as tickets_sold
            FROM screenings s
            JOIN movies m ON s.movieid = m.movieid
            JOIN halls h ON s.hallid = h.hallid
            LEFT JOIN tickets t ON s.screeningid = t.screeningid AND t.status = 'Оплачен'
            WHERE s.starttime >= NOW() - INTERVAL '1 hour'
            GROUP BY s.screeningid, s.starttime, m.title, h.name, s.iscancelled, m.durationmin
            ORDER BY s.starttime DESC;
        `;

        const { rows: upcomingScreenings } = await pool.query(upcomingScreeningsQuery);

        res.render('admin/sessions-manage', {
            title: 'Управление сеансами',
            isSessionsAdmin: true,
            movies,
            halls,
            upcomingScreenings,
            error: req.flash('error')[0] || null,
            success: req.flash('success')[0] || null,
            formData: req.flash('formData')[0] || {}
        });

    } catch (e) {
        console.error('Ошибка при загрузке страницы управления сеансами:', e);
        res.status(500).render('error', { title: 'Ошибка сервера' });
    }
});

// POST /admin/sessions - Создание нового сеанса
router.post('/sessions', adminMiddleware,
    sessionValidators,
    async (req, res) => {
        const errors = validationResult(req);
        const { movieId, hallId, startTime } = req.body;

        if (!errors.isEmpty()) {
            req.flash('error', errors.array()[0].msg);
            req.flash('formData', req.body);
            return req.session.save(() => res.redirect('/admin/sessions'));
        }

        const requestedStart = new Date(startTime);
        const now = new Date();

        // Проверка: нельзя создать сеанс в прошлом
        if (requestedStart < now) {
            req.flash('error', 'Нельзя создать сеанс в прошлом.');
            req.flash('formData', req.body);
            return req.session.save(() => res.redirect('/admin/sessions'));
        }

        try {
            // Получаем информацию о фильме
            const { rows: movieInfo } = await pool.query(
                'SELECT durationmin, title FROM movies WHERE movieid = $1',
                [movieId]
            );

            if (movieInfo.length === 0) {
                req.flash('error', 'Выбранный фильм не найден.');
                return req.session.save(() => res.redirect('/admin/sessions'));
            }

            const newMovieDurationMin = movieInfo[0].durationmin;
            const movieTitle = movieInfo[0].title;
            // Полная длительность: фильм + уборка
            const newSessionFullDurationMs = (newMovieDurationMin * 60000) + CLEANING_TIME_MS;

            // Время окончания запрашиваемого сеанса (с уборкой)
            const requestedEndMs = requestedStart.getTime() + newSessionFullDurationMs;

            // Определяем границы рабочего дня
            const dayStart = new Date(requestedStart);
            dayStart.setHours(DAY_START_HOUR, 0, 0, 0); // 9:00

            const dayEndLimit = new Date(requestedStart);
            dayEndLimit.setHours(LATEST_START_HOUR, 0, 0, 0); // 21:00

            // Проверка: сеанс должен начинаться в рабочее время (9:00 - 21:00 ВКЛЮЧИТЕЛЬНО)
            // Разрешаем сеансы, которые начинаются РОВНО в 21:00
            if (requestedStart.getTime() < dayStart.getTime() ||
                requestedStart.getHours() > LATEST_START_HOUR ||
                (requestedStart.getHours() === LATEST_START_HOUR && requestedStart.getMinutes() > 0)) {
                req.flash('error', `Сеанс должен начинаться в рабочее время (${DAY_START_HOUR}:00 - ${LATEST_START_HOUR}:00).`);
                req.flash('formData', req.body);
                return req.session.save(() => res.redirect('/admin/sessions'));
            }

            // Проверка: сеанс должен заканчиваться до 21:00 + время уборки
            const sessionEndTime = new Date(requestedStart.getTime() + (newMovieDurationMin * 60000) + CLEANING_TIME_MS);
            const dayEndWithCleaning = new Date(requestedStart);
            dayEndWithCleaning.setHours(LATEST_START_HOUR, CLEANING_TIME_MINUTES, 0, 0); // 21:15

            if (sessionEndTime.getTime() > dayEndWithCleaning.getTime()) {
                req.flash('error', `Фильм "${movieTitle}" слишком длинный (${newMovieDurationMin} мин) для начала в ${requestedStart.getHours()}:${requestedStart.getMinutes().toString().padStart(2, '0')}. Последний сеанс должен заканчиваться до ${LATEST_START_HOUR}:${CLEANING_TIME_MINUTES.toString().padStart(2, '0')}.`);
                req.flash('formData', req.body);
                return req.session.save(() => res.redirect('/admin/sessions'));
            }

            // Получаем все существующие сеансы на этот день
            const allSessionsQuery = `
                SELECT 
                    s.screeningid,
                    s.starttime,
                    m.durationmin,
                    m.title as movie_title
                FROM screenings s
                JOIN movies m ON s.movieid = m.movieid
                WHERE s.hallid = $1 
                AND s.iscancelled = FALSE 
                AND s.starttime >= $2::timestamp 
                AND s.starttime <= $3::timestamp 
                ORDER BY s.starttime ASC; 
            `;

            const searchDayStart = new Date(requestedStart);
            searchDayStart.setHours(0, 0, 0, 0);

            const searchDayEnd = new Date(requestedStart);
            searchDayEnd.setHours(23, 59, 59, 999);

            const { rows: existingSessions } = await pool.query(
                allSessionsQuery,
                [hallId, searchDayStart.toISOString(), searchDayEnd.toISOString()]
            );

            // Проверка на конфликты с существующими сеансами
            let collisionFound = false;
            let conflictingMovie = '';

            for (let i = 0; i < existingSessions.length; i++) {
                const session = existingSessions[i];
                const existStartMs = new Date(session.starttime).getTime();
                const existEndMs = existStartMs + (session.durationmin * 60000) + CLEANING_TIME_MS;

                // Проверка пересечения
                if (requestedStart.getTime() < existEndMs && existStartMs < requestedEndMs) {
                    collisionFound = true;
                    conflictingMovie = session.movie_title;
                    break;
                }
            }

            // Если найден конфликт, ищем свободные слоты
            if (collisionFound) {
                let suggestions = [];
                let slotsFoundCount = 0;

                let windowStartMs = dayStart.getTime();

                // Проходим по всем сеансам + дополнительное окно после последнего
                for (let i = 0; i <= existingSessions.length; i++) {
                    let windowEndMs;

                    if (i < existingSessions.length) {
                        windowEndMs = new Date(existingSessions[i].starttime).getTime();
                    } else {
                        // Последнее окно заканчивается в 21:00 (начало последнего сеанса)
                        windowEndMs = dayEndLimit.getTime();
                    }

                    const gapSize = windowEndMs - windowStartMs;

                    // Проверяем, поместится ли фильм в этот промежуток
                    let fits = false;
                    if (i === existingSessions.length) {
                        // Последний слот (вечер) - проверяем, что можем начать до 21:00
                        if (windowStartMs <= dayEndLimit.getTime()) {
                            fits = true;
                        }
                    } else {
                        // Промежуточный слот
                        if (gapSize >= newSessionFullDurationMs) {
                            fits = true;
                        }
                    }

                    if (fits) {
                        // 1. Предложение "рано" (в начале окна)
                        let earlyStart = new Date(windowStartMs);
                        earlyStart = roundToNearestFiveMinutes(earlyStart);

                        if (i < existingSessions.length) {
                            // Проверяем, что после округления мы не вышли за границы
                            if (earlyStart.getTime() + newSessionFullDurationMs <= windowEndMs) {
                                const tStr = earlyStart.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                                suggestions.push(`${tStr}`);
                                slotsFoundCount++;
                            }
                        } else {
                            // Вечерний слот - проверяем лимит 21:00
                            if (earlyStart.getTime() <= dayEndLimit.getTime()) {
                                const tStr = earlyStart.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                                suggestions.push(`${tStr}`);
                                slotsFoundCount++;
                            }
                        }

                        // 2. Предложение "поздно" (в конце окна, если есть место)
                        if (i < existingSessions.length) {
                            let lateStartMs = windowEndMs - newSessionFullDurationMs;

                            // Если разница между началом окна и поздним стартом > 15 минут
                            if (lateStartMs - windowStartMs > 15 * 60000) {
                                let lateStart = new Date(lateStartMs);
                                lateStart = roundToNearestFiveMinutes(lateStart);

                                // Коррекция: если округление привело к пересечению
                                if (lateStart.getTime() + newSessionFullDurationMs > windowEndMs) {
                                    lateStart.setMinutes(lateStart.getMinutes() - 5);
                                }

                                // Проверяем, что не вышли за начало окна
                                if (lateStart.getTime() >= windowStartMs) {
                                    const tStr = lateStart.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                                    suggestions.push(`${tStr}`);
                                    slotsFoundCount++;
                                }
                            }
                        }
                    }

                    // Обновляем начало следующего окна
                    if (i < existingSessions.length) {
                        windowStartMs = new Date(existingSessions[i].starttime).getTime() +
                            (existingSessions[i].durationmin * 60000) +
                            CLEANING_TIME_MS;
                    }

                    // Ограничиваем количество предложений
                    if (slotsFoundCount >= 4) break;
                }

                // Формируем сообщение об ошибке с предложениями
                if (suggestions.length === 0) {
                    req.flash('error', `Конфликт с фильмом "${conflictingMovie}"! В этот день нет свободного времени для фильма длительностью ${newMovieDurationMin} мин (+${CLEANING_TIME_MINUTES} мин уборка).`);
                } else {
                    const uniqueSuggestions = [...new Set(suggestions)].sort();
                    req.flash('error', `Конфликт с фильмом "${conflictingMovie}"! Свободные слоты в этом зале: ${uniqueSuggestions.join(', ')}.`);
                }

                req.flash('formData', req.body);
                return req.session.save(() => res.redirect('/admin/sessions'));
            }

            // Если конфликтов нет, создаем сеанс
            const insertQuery = `
                INSERT INTO screenings (movieid, hallid, starttime)
                VALUES ($1, $2, $3)
                RETURNING screeningid;
            `;

            await pool.query(insertQuery, [movieId, hallId, startTime]);

            req.flash('success', `Сеанс фильма "${movieTitle}" успешно создан на ${requestedStart.toLocaleString('ru-RU')}!`);
            req.session.save(() => res.redirect('/admin/sessions'));

        } catch (e) {
            console.error('Ошибка при создании сеанса:', e);

            if (e.code === '23505') {
                req.flash('error', 'Дубликат сеанса (возможно, в базе есть скрытый отмененный сеанс).');
            } else if (e.code === '23503') {
                req.flash('error', 'Ошибка внешнего ключа (фильм или зал не существуют).');
            } else {
                req.flash('error', 'Произошла ошибка сервера при создании сеанса.');
            }

            req.flash('formData', req.body);
            await req.session.save(() => res.redirect('/admin/sessions'));
        }
    }
);

// POST /admin/sessions/:id/cancel - Отмена сеанса
router.post('/sessions/:id/cancel', adminMiddleware, async (req, res) => {
    const screeningId = req.params.id;

    if (!screeningId || isNaN(parseInt(screeningId))) {
        req.flash('error', 'Некорректный ID сеанса');
        return res.redirect('/admin/sessions');
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const screeningInfo = await client.query(`
            SELECT 
                s.*, 
                m.title as movie_title, 
                m.durationmin,
                h.name as hall_name,
                COUNT(t.ticketid) as total_tickets,
                SUM(CASE WHEN t.status = 'Оплачен' THEN 1 ELSE 0 END) as paid_tickets
            FROM screenings s
            JOIN movies m ON s.movieid = m.movieid
            JOIN halls h ON s.hallid = h.hallid
            LEFT JOIN tickets t ON s.screeningid = t.screeningid
            WHERE s.screeningid = $1
            GROUP BY s.screeningid, m.title, m.durationmin, h.name
        `, [screeningId]);

        if (screeningInfo.rows.length === 0) {
            await client.query('ROLLBACK');
            req.flash('error', 'Сеанс не найден.');
            return req.session.save(() => res.redirect('/admin/sessions'));
        }

        const screening = screeningInfo.rows[0];

        const now = new Date();
        const startTime = new Date(screening.starttime);

        if (startTime <= now) {
            await client.query('ROLLBACK');
            req.flash('error', 'Нельзя отменить уже начавшийся или завершившийся сеанс.');
            return req.session.save(() => res.redirect('/admin/sessions'));
        }

        const ticketsQuery = `
            SELECT 
                t.ticketid,
                t.userid,
                t.totalprice,
                t.qrtoken,
                pm.payment_id,
                pm.yookassa_payment_id,
                pm.amount,
                pm.currency,
                u.email as user_email,
                u.firstname,
                u.lastname,
                u.nickname,
                u.telegramid,
                u.enablenotifications
            FROM tickets t
            JOIN payment_metadata pm ON t.qrtoken = pm.ticket_token
            JOIN users u ON t.userid = u.userid
            WHERE t.screeningid = $1 
            AND t.status = 'Оплачен'
            AND pm.yookassa_payment_id IS NOT NULL
            AND pm.yookassa_payment_id != '';
        `;

        const { rows: tickets } = await client.query(ticketsQuery, [screeningId]);

        const cancelQuery = `
            UPDATE screenings 
            SET iscancelled = TRUE 
            WHERE screeningid = $1
            RETURNING movieid;
        `;

        await client.query(cancelQuery, [screeningId]);

        let refundCount = 0;
        const notifiedUsers = new Set();
        let totalRefundedAmount = 0;

        for (const ticket of tickets) {
            await client.query(`
                UPDATE tickets
                SET status = 'Возвращен',
                    refundedat = CURRENT_TIMESTAMP
                WHERE ticketid = $1
            `, [ticket.ticketid]);

            const simulatedRefundId = `admin_screening_rf_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

            let amountInRub;
            if (ticket.amount && !isNaN(parseFloat(ticket.amount))) {
                amountInRub = parseFloat(ticket.amount);
            } else if (ticket.totalprice && !isNaN(parseFloat(ticket.totalprice))) {
                amountInRub = parseFloat(ticket.totalprice);
            } else {
                amountInRub = 0;
            }

            totalRefundedAmount += amountInRub;

            await client.query(`
                INSERT INTO refunds (
                    ticket_id,
                    payment_id,
                    refund_id,
                    amount,
                    currency,
                    status,
                    reason,
                    yookassa_payment_id,
                    is_simulated
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
            `, [
                ticket.ticketid,
                ticket.payment_id,
                simulatedRefundId,
                amountInRub,
                ticket.currency || 'RUB',
                'succeeded',
                `Возврат из-за отмены сеанса "${screening.movie_title}" администратором`,
                ticket.yookassa_payment_id
            ]);

            refundCount++;

            const userName = ticket.firstname || ticket.nickname || ticket.user_email.split('@')[0] || 'Клиент';

            if (!notifiedUsers.has(ticket.userid)) {

                const screeningDetails = {
                    movie_title: screening.movie_title,
                    hall_name: screening.hall_name,
                    starttime: screening.starttime
                };

                if (ticket.telegramid && ticket.enablenotifications) {
                    try {
                        await sendScreeningCancellationNotification(
                            ticket.telegramid,
                            screeningDetails,
                            amountInRub
                        );
                        console.log(`📱 Telegram уведомление об отмене сеанса отправлено пользователю ${ticket.telegramid} (${userName})`);
                    } catch (telegramError) {
                        console.error(`❌ Ошибка отправки Telegram уведомления пользователю ${ticket.userid}:`, telegramError.message);
                    }
                }

                if (ticket.user_email) {
                    try {
                        await sendScreeningCancellationEmail(
                            ticket.user_email,
                            userName,
                            screeningDetails,
                            amountInRub
                        );
                        console.log(`📧 Email уведомление об отмене сеанса отправлено на ${ticket.user_email} (${userName})`);
                    } catch (emailError) {
                        console.error(`❌ Ошибка отправки Email уведомления пользователю ${ticket.userid} (${ticket.user_email}):`, emailError.message);
                    }
                }

                notifiedUsers.add(ticket.userid);
            }

            console.log(`✅ Админ: возврат для билета ${ticket.ticketid} пользователя ${ticket.user_email}: ${simulatedRefundId}`);
        }

        const reservedTicketsQuery = `
            SELECT ticketid, userid
            FROM tickets 
            WHERE screeningid = $1 
            AND status = 'Забронирован';
        `;

        const { rows: reservedTickets } = await client.query(reservedTicketsQuery, [screeningId]);

        for (const ticket of reservedTickets) {
            await client.query(`
                UPDATE tickets
                SET status = 'Отменен администратором',
                    refundedat = CURRENT_TIMESTAMP
                WHERE ticketid = $1
            `, [ticket.ticketid]);

            console.log(`ℹ️ Админ: бронь билета ${ticket.ticketid} отменена (не было оплаты)`);
        }

        await client.query('COMMIT');

        let message = `Сеанс "${screening.movie_title}" (${startTime.toLocaleString('ru-RU')}, зал ${screening.hall_name}) успешно отменен.`;

        if (refundCount > 0) {
            message += ` Возвращено ${refundCount} оплаченных билетов (на общую сумму ${totalRefundedAmount.toFixed(2)} BYN).`;

            const notificationMethods = [];
            if (tickets.some(t => t.user_email) && notifiedUsers.size > 0) {
                notificationMethods.push('Email');
            }
            if (tickets.some(t => t.telegramid && t.enablenotifications) && notifiedUsers.size > 0) {
                notificationMethods.push('Telegram');
            }

            if (notificationMethods.length > 0) {
                message += ` Уведомления об отмене и возврате отправлены ${notifiedUsers.size} пользователям через: ${notificationMethods.join(' и ')}.`;
            } else {
                message += ` Не удалось отправить уведомления: пользователи не настроили Email/Telegram.`;
            }
        }

        if (reservedTickets.length > 0) {
            message += ` Отменено ${reservedTickets.length} бронирований.`;
        }

        req.flash('success', message);

    } catch (e) {
        await client.query('ROLLBACK');
        console.error(`❌ Ошибка при отмене сеанса ${screeningId}:`, e);
        req.flash('error', 'Критическая ошибка при отмене сеанса.');
    } finally {
        client.release();
    }

    req.session.save(() => res.redirect('/admin/sessions'));
});

// GET /admin/sessions/report - Скачать полный отчет по всем сеансам
const ExcelJS = require('exceljs');
router.get('/sessions/report',adminMiddleware, async (req, res) => {
    try {
        const reportQuery = `
            SELECT
                s.screeningid AS "ID_сеанса",
                m.title AS "Фильм",
                h.name AS "Зал",
                TO_CHAR(s.starttime, 'DD.MM.YYYY HH24:MI') AS "Дата_и_время_начала",
                TO_CHAR(s.starttime + (m.durationmin || ' minutes')::INTERVAL, 'HH24:MI') AS "Время_окончания",
                m.durationmin AS "Длительность_фильма",
                m.price AS "Цена_билета",
                CASE 
                    WHEN s.iscancelled THEN 'Отменен'
                    WHEN s.starttime < NOW() THEN 'Завершен'
                    ELSE 'Активен'
                END AS "Статус",
                COUNT(DISTINCT t.ticketid) AS "Количество_проданных_билетов",
                COALESCE(SUM(t.totalprice), 0) AS "Общая_выручка"
            FROM screenings s
            JOIN movies m ON s.movieid = m.movieid
            JOIN halls h ON s.hallid = h.hallid
            LEFT JOIN tickets t ON s.screeningid = t.screeningid AND t.status = 'Оплачен'
            GROUP BY s.screeningid, m.title, h.name, s.starttime, m.durationmin, m.price, s.iscancelled
            ORDER BY s.starttime DESC;
        `;

        const { rows: reportData } = await pool.query(reportQuery);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Сеансы');

        worksheet.columns = [
            { header: 'ID сеанса', key: 'id', width: 10 },
            { header: 'Фильм', key: 'movie', width: 30 },
            { header: 'Зал', key: 'hall', width: 15 },
            { header: 'Дата и время начала', key: 'start', width: 20 },
            { header: 'Время окончания', key: 'end', width: 15 },
            { header: 'Длительность (мин)', key: 'duration', width: 15 },
            { header: 'Цена билета', key: 'price', width: 12, style: { numFmt: '#,##0.00' } },
            { header: 'Статус', key: 'status', width: 12 },
            { header: 'Проданных билетов', key: 'tickets', width: 15 },
            { header: 'Общая выручка', key: 'revenue', width: 15, style: { numFmt: '#,##0.00' } }
        ];

        reportData.forEach(row => {
            worksheet.addRow({
                id: row["ID_сеанса"],
                movie: row["Фильм"],
                hall: row["Зал"],
                start: row["Дата_и_время_начала"],
                end: row["Время_окончания"],
                duration: row["Длительность_фильма"],
                price: row["Цена_билета"] || 0,
                status: row["Статус"],
                tickets: row["Количество_проданных_билетов"],
                revenue: row["Общая_выручка"]
            });
        });

        const totalRow = reportData.length + 2;
        worksheet.mergeCells(`A${totalRow}:H${totalRow}`);

        const totalRevenue = reportData.reduce((sum, row) => sum + (parseFloat(row["Общая_выручка"]) || 0), 0);
        const totalTickets = reportData.reduce((sum, row) => sum + (parseInt(row["Количество_проданных_билетов"]) || 0), 0);

        worksheet.getCell(`A${totalRow}`).value = `Итого: ${totalTickets} билетов на сумму ${totalRevenue.toFixed(2)} руб.`;
        worksheet.getCell(`A${totalRow}`).font = { bold: true };
        worksheet.getCell(`A${totalRow}`).alignment = { horizontal: 'right' };

        const headerRow = worksheet.getRow(1);
        headerRow.font = { bold: true, size: 12 };
        headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
        headerRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE0E0E0' }
        };

        worksheet.eachRow({ includeEmpty: false }, (row) => {
            row.eachCell({ includeEmpty: false }, (cell) => {
                cell.border = {
                    top: { style: 'thin' },
                    left: { style: 'thin' },
                    bottom: { style: 'thin' },
                    right: { style: 'thin' }
                };
                cell.alignment = { vertical: 'middle', horizontal: 'center' };
            });
        });

        worksheet.columns.forEach(column => {
            let maxLength = 0;
            column.eachCell({ includeEmpty: false }, (cell) => {
                const columnLength = cell.value ? cell.value.toString().length : 10;
                if (columnLength > maxLength) {
                    maxLength = columnLength;
                }
            });
            column.width = maxLength < 10 ? 10 : maxLength + 2;
        });

        const fileName = `seansy_otchet_${new Date().toISOString().split('T')[0]}.xlsx`;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (e) {
        console.error('Ошибка при генерации Excel отчета:', e);
        req.flash('error', 'Ошибка при формировании отчета.');
        res.redirect('/admin/sessions');
    }
});

// GET /admin/add-short - Рендер страницы добавления короткого видео
router.get('/add-short', adminMiddleware,async (req, res) => {
    try {
        const { rows: movies } = await pool.query(
            'SELECT movieid, title FROM movies WHERE isactive = TRUE ORDER BY title'
        );

        res.render('admin/add-short', {
            title: 'Добавить короткое видео',
            movies: movies,
            formData: req.flash('formData')[0] || {},
            error: req.flash('error'),
            success: req.flash('success')
        });
    } catch (e) {
        console.error('Ошибка загрузки страницы добавления видео:', e);
        req.flash('error', 'Ошибка сервера при загрузке списка фильмов.');
        res.redirect('/');
    }
});

// POST /admin/add-short - Обработка формы добавления короткого видео
router.post('/add-short', adminMiddleware,
    (req, res, next) => {
        uploadShortVideo(req, res, (err) => {
            if (err) {
                const errorMessage = err instanceof multer.MulterError ?
                    `Ошибка загрузки видео: ${err.message}. Макс. размер 20MB.` :
                    `Критическая ошибка файла: ${err.message}`;
                req.flash('error', errorMessage);
                req.flash('formData', req.body);
                return res.redirect('/admin/add-short');
            }
            if (!req.file) {
                req.flash('error', 'Видеофайл обязателен для добавления');
                req.flash('formData', req.body);
                return res.redirect('/admin/add-short');
            }
            next();
        });
    },
    shortVideoValidators,
    async (req, res) => {
        const errors = validationResult(req);
        const { movieId, title, durationsec, description } = req.body;

        if (!errors.isEmpty()) {
            if (req.file && req.file.path) {
                fs.unlink(req.file.path, (err) => {
                    if (err) console.error('Ошибка удаления временного видеофайла после ошибки валидации:', err);
                });
            }

            req.flash('error', errors.array()[0].msg);
            req.flash('formData', req.body);
            return res.status(422).redirect('/admin/add-short');
        }

        const client = await pool.connect();
        const tempPath = req.file.path;
        let videoUrl = null;

        try {
            await client.query('BEGIN');

            const destinationKey = `shorts/${req.file.filename}`;
            videoUrl = await uploadFile(tempPath, destinationKey);

            const insertQuery = `
                INSERT INTO shorts (movieid, title, videopath, durationsec)
                VALUES ($1, $2, $3, $4) 
                RETURNING shortid;
            `;

            await pool.query(insertQuery, [movieId, title, videoUrl, durationsec]);

            await client.query('COMMIT');

            fs.unlink(tempPath, (err) => {
                if (err) console.error('Ошибка удаления временного видеофайла после загрузки в облако:', err);
            });

            req.flash('success', `Короткое видео "${title}" успешно добавлено.`);
            res.redirect('/admin/add-short');

        } catch (e) {
            await client.query('ROLLBACK');
            console.error('Ошибка добавления короткого видео:', e);

            if (req.file && req.file.path) {
                fs.unlink(req.file.path, (err) => {
                    if (err) console.error('Ошибка удаления временного видеофайла после ошибки БД:', err);
                });
            }

            req.flash('error', 'Произошла ошибка сервера при добавлении видео.');
            req.flash('formData', req.body);
            res.redirect('/admin/add-short');
        } finally {
            client.release();
        }
    }
);

router.post('/shorts/:shortid/delete',adminMiddleware, async (req, res) => {
    const shortId = req.params.shortid;
    const redirectUrl = '/shorts';

    if (!shortId || isNaN(parseInt(shortId))) {
        req.flash('error', 'Некорректный ID короткого видео.');
        return res.redirect(redirectUrl);
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const result = await client.query(
            'SELECT videopath FROM shorts WHERE shortid = $1',
            [shortId]
        );

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            req.flash('error', `Короткое видео с ID ${shortId} не найдено.`);
            return res.redirect(redirectUrl);
        }

        const videoPath = result.rows[0].videopath;

        await client.query('DELETE FROM shorts WHERE shortid = $1', [shortId]);

        await client.query('COMMIT');

        if (videoPath) {
            deleteFile(videoPath)
                .catch(e => {
                    console.error(`❌ Ошибка удаления файла ${videoPath} через сервис хранения:`, e);
                });
        }
        res.redirect(redirectUrl);

    } catch (e) {
        await client.query('ROLLBACK');
        console.error('❌ Ошибка удаления короткого видео:', e);
        req.flash('error', 'Произошла ошибка сервера при удалении видео.');
        res.redirect(redirectUrl);
    } finally {
        client.release();
    }
});


module.exports = router;