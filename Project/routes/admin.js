const { Router } = require('express');
const { body, validationResult } = require('express-validator');
const router = Router();
const pool = require('../db'); // Предполагаем, что подключение к БД доступно
const adminMiddleware = require('../middleware/admin'); // Предполагаем, что мидлварь доступен
const path = require('path');
const multer = require('multer');
const fs = require('fs');

// --- КОНСТАНТЫ И ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ СЕАНСОВ ---
const CLEANING_TIME_MINUTES = 30;
const CLEANING_TIME_MS = CLEANING_TIME_MINUTES * 60000;

// ЛИМИТЫ РАБОТЫ КИНОТЕАТРА
const DAY_START_HOUR = 9; // КИНОТЕАТР ОТКРЫВАЕТСЯ В 9:00 (Обновлено)
const LATEST_START_HOUR = 21; // Последний сеанс должен начаться не позднее 21:00

// Вспомогательная функция для округления времени до ближайших 5 минут
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
// --- КОНЕЦ КОНСТАНТ СЕАНСОВ ---

router.use(adminMiddleware);

// --- НАСТРОЙКА MULTER ДЛЯ ФАЙЛОВ ---
// Постеры фильмов
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'public/uploads/posters');
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
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Разрешены только файлы изображений!'), false);
        }
    }
}).single('posterFile');

// Фото режиссеров
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
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Разрешены только файлы изображений!'), false);
        }
    }
}).single('directorPhoto');

// --- НАСТРОЙКА MULTER ДЛЯ КОРОТКИХ ВИДЕО ---
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
        // Сохраняем видео с уникальным префиксом
        cb(null, 'short-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const uploadShortVideo = multer({
    storage: shortVideoStorage,
    limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB лимит для видео
    fileFilter: (req, file, cb) => {
        // Разрешаем только видеофайлы
        if (file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Разрешены только видеофайлы!'), false);
        }
    }
}).single('shortVideoFile'); // Имя поля в форме

// --- ВАЛИДАТОРЫ ---
const movieValidators = [
    body('title', 'Название фильма (Русское) должно быть не менее 2 символов').isLength({ min: 2 }).trim(),
    body('originaltitle', 'Оригинальное название (Английское) должно быть не менее 1 символа').isLength({ min: 1 }).trim(),
    body('durationmin', 'Продолжительность должна быть числом').isInt({ min: 1 }).toInt(),
    body('releaseYear', 'Год выпуска должен быть корректным годом (4 цифры)').isInt().isLength({ min: 4, max: 4 }).toInt(),
    body('price', 'Цена билета должна быть числом').isFloat({ min: 0 }).toFloat(),
    body('directorName', 'Имя режиссера обязательно').notEmpty().trim()
];

const directorValidators = [
    body('name', 'Имя режиссера должно быть не менее 2 символов').isLength({ min: 2 }).trim(),
    body('birthdate', 'Дата рождения должна быть в формате ГГГГ-ММ-ДД (YYYY-MM-DD) или пустой').optional({ checkFalsy: true }).isISO8601().toDate(),
    body('biography', 'Биография не может быть пустой').notEmpty().trim()
];

// --- МАРШРУТЫ ДЛЯ ФИЛЬМОВ ---
router.get('/add', (req, res) => {
    res.render('admin/add', {
        title: 'Добавить новый фильм',
        movieData: req.flash('movieData')[0] || {},
        error: req.flash('error'),
        success: req.flash('success')
    });
});

router.post('/add', (req, res, next) => {
        upload(req, res, (err) => {
            if (err) {
                const errorMessage = err instanceof multer.MulterError ?
                    `Ошибка загрузки постера: ${err.message}. Макс. размер 5MB.` :
                    `Критическая ошибка файла: ${err.message}`;
                req.flash('error', errorMessage);
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
            req.flash('error', errors.array()[0].msg);
            req.flash('movieData', req.body);
            return res.status(422).redirect('/admin/add');
        }

        const posterUrl = req.file ? `/uploads/posters/${req.file.filename}` : null;

        if (!posterUrl) {
            req.flash('error', 'Ошибка: Файл постера не был загружен.');
            req.flash('movieData', req.body);
            return res.redirect('/admin/add');
        }

        let {
            title, originaltitle, description, durationmin, genre, trailerUrl,
            releaseYear, directorName, price, isActive
        } = req.body;

        // 💡 НОВАЯ ЛОГИКА: Нормализация жанров
        // Превращает "Боевик,  ДРАМА " -> "боевик, драма"
        if (genre) {
            genre = genre
                .split(',')                       // Разбиваем по запятой
                .map(g => g.trim().toLowerCase()) // Убираем пробелы и переводим в нижний регистр
                .filter(g => g.length > 0)        // Убираем пустые элементы
                .join(', ');                      // Собираем обратно
        }

        try {
            let directorId;
            let directorResult = await pool.query('SELECT directorid FROM directors WHERE name = $1', [directorName]);

            if (directorResult.rows.length > 0) {
                directorId = directorResult.rows[0].directorid;
            } else {
                directorResult = await pool.query('INSERT INTO directors (name) VALUES ($1) RETURNING directorid', [directorName]);
                directorId = directorResult.rows[0].directorid;
            }

            const insertQuery = `
                INSERT INTO movies (
                    title, originaltitle, description, durationmin, genre, posterurl, trailerurl,
                    releaseyear, directorid, isactive, price
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) 
                RETURNING movieid;
            `;

            await pool.query(insertQuery, [
                title, originaltitle, description, durationmin, genre, posterUrl, trailerUrl,
                releaseYear, directorId, isActive === 'on', price
            ]);

            req.flash('success', `Фильм "${title}" успешно добавлен.`);
            res.redirect('/admin/add');

        } catch (e) {
            console.error('Ошибка добавления фильма:', e);
            if (req.file && req.file.path) {
                fs.unlink(req.file.path, (err) => {
                    if (err) console.error('Ошибка удаления файла:', err);
                });
            }

            req.flash('error', 'Произошла ошибка сервера при добавлении фильма.');
            req.flash('movieData', req.body);
            res.redirect('/admin/add');
        }
    }
);


// GET /:movieid/edit - Рендер страницы редактирования
router.get('/movies/:movieid/edit', async (req, res) => {
    const movieId = req.params.movieid;
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
router.post('/movies/:movieid/edit', (req, res, next) => {
        const movieId = req.params.movieid;
        const redirectUrl = `/admin/movies/${movieId}/edit`;

        upload(req, res, (err) => {
            if (err) {
                const errorMessage = err instanceof multer.MulterError ?
                    `Ошибка загрузки постера: ${err.message}. Макс. размер 5MB.` :
                    `Критическая ошибка файла: ${err.message}`;
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

        const { title, originaltitle, description, durationmin, genre, trailerUrl, releaseYear, directorName, price, isActive } = req.body;
        let newPosterUrl = req.file ? `/uploads/posters/${req.file.filename}` : null;
        let oldPosterPath = null;

        try {
            if (newPosterUrl) {
                const oldMovieResult = await pool.query('SELECT posterurl FROM movies WHERE movieid = $1', [movieId]);
                if (oldMovieResult.rows.length > 0) {
                    oldPosterPath = oldMovieResult.rows[0].posterurl;
                }
            }

            let directorId;
            let directorResult = await pool.query('SELECT directorid FROM directors WHERE name = $1', [directorName]);
            if (directorResult.rows.length > 0) {
                directorId = directorResult.rows[0].directorid;
            } else {
                directorResult = await pool.query('INSERT INTO directors (name) VALUES ($1) RETURNING directorid', [directorName]);
                directorId = directorResult.rows[0].directorid;
            }

            const updateQuery = `
                UPDATE movies 
                SET title = $1, originaltitle = $2, description = $3, durationmin = $4, genre = $5, 
                    posterurl = COALESCE($6, posterurl), trailerurl = $7, releaseyear = $8, 
                    directorid = $9, isactive = $10, price = $11 
                WHERE movieid = $12
            `;

            await pool.query(updateQuery, [
                title, originaltitle, description, durationmin, genre, newPosterUrl, trailerUrl,
                releaseYear, directorId, isActive === 'on', price, movieId
            ]);

            if (newPosterUrl && oldPosterPath) {
                const absolutePath = path.join(__dirname, '..', 'public', oldPosterPath);
                fs.unlink(absolutePath, (err) => {
                    if (err) console.error('Не удалось удалить старый постер:', err);
                });
            }

            req.flash('success', `Фильм "${title}" успешно обновлен.`);
            res.redirect(redirectUrl);

        } catch (e) {
            console.error('Ошибка обновления фильма:', e);
            if (req.file && req.file.path) {
                fs.unlink(req.file.path, (err) => {
                    if (err) console.error('Не удалось удалить загруженный файл после ошибки БД:', err);
                });
            }

            req.flash('error', 'Произошла ошибка сервера при обновлении фильма.');
            req.flash('movieData', req.body);
            res.redirect(redirectUrl);
        }
    });

// POST /admin/movies/:movieid/delete - Маршрут для удаления
router.post('/movies/:movieid/delete', async (req, res) => {
    const movieId = req.params.movieid;

    try {
        const movieResult = await pool.query('SELECT posterurl FROM movies WHERE movieid = $1', [movieId]);
        if (movieResult.rows.length === 0) {
            req.flash('error', 'Фильм для удаления не найден.');
            return res.redirect('/');
        }
        const posterUrl = movieResult.rows[0].posterurl;

        await pool.query('DELETE FROM movies WHERE movieid = $1', [movieId]);

        if (posterUrl) {
            const absolutePath = path.join(__dirname, '..', 'public', posterUrl);
            fs.unlink(absolutePath, (err) => {
                if (err) console.error('Не удалось удалить постер фильма:', err);
            });
        }

        req.flash('success', 'Фильм успешно удален.');
        res.redirect('/');

    } catch (e) {
        console.error('Ошибка удаления фильма:', e);
        req.flash('error', 'Произошла ошибка сервера при удалении фильма.');
        res.redirect('/admin/movies/' + movieId + '/edit');
    }
});


// --- МАРШРУТЫ ДЛЯ ПОЛЬЗОВАТЕЛЕЙ ---

async function getRegularUsers(searchEmail) {
    let query = `
        SELECT 
            userid, 
            email, 
            firstname, 
            lastname, 
            phone, 
            role
        FROM users
        WHERE role = 'Пользователь'
    `;
    const params = [];

    if (searchEmail) {
        query += ` AND email ILIKE $1`;
        params.push(`%${searchEmail}%`);
    }

    query += ` ORDER BY userid ASC`;

    const result = await pool.query(query, params);
    return result.rows;
}

// GET /admin/users - Страница управления пользователями
router.get('/users', async (req, res) => {
    const searchEmail = req.query.searchEmail ? req.query.searchEmail.trim() : null;

    const errorMessages = req.flash('error');
    const successMessages = req.flash('success');

    try {
        const users = await getRegularUsers(searchEmail);

        res.render('admin/users', {
            title: 'Управление пользователями',
            isAdminPage: true,
            users: users,
            user: req.session.user,
            searchEmail: searchEmail,
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
router.post('/users/delete', async (req, res) => {
    const userIdToDelete = String(req.body.userId);
    const currentUserId = String(req.session.user.userid);

    if (userIdToDelete === currentUserId) {
        req.flash('error', 'Невозможно удалить собственный аккаунт через панель управления.');
        return res.redirect('/admin/users');
    }

    if (!userIdToDelete || isNaN(parseInt(userIdToDelete))) {
        req.flash('error', 'Неверный ID пользователя.');
        return res.redirect('/admin/users');
    }

    try {
        await pool.query('BEGIN');

        await pool.query(`
            DELETE FROM user_sessions WHERE sess->'user'->>'userid' = $1;
        `, [userIdToDelete]);

        const deleteQuery = 'DELETE FROM users WHERE userid = $1 AND role = \'Пользователь\'';
        const result = await pool.query(deleteQuery, [userIdToDelete]);

        await pool.query('COMMIT');

        if (result.rowCount > 0) {
            req.flash('success', `Пользователь ID: ${userIdToDelete} успешно удален.`);
        } else {
            req.flash('error', `Пользователь с ID: ${userIdToDelete} не найден, не является Пользователем или был удален ранее.`);
        }

    } catch (e) {
        await pool.query('ROLLBACK');
        console.error('Ошибка при удалении пользователя:', e);
        req.flash('error', 'Произошла ошибка базы данных при удалении пользователя.');
    }

    res.redirect('/admin/users');
});


// POST /admin/reviews/:reviewid/delete - Маршрут для удаления отзыва администратором
router.post('/reviews/:reviewid/delete', async (req, res) => {
    const reviewId = req.params.reviewid;
    const referer = req.header('Referer') || '/';

    try {
        if (!reviewId || isNaN(parseInt(reviewId))) {
            req.flash('error', 'Неверный ID отзыва.');
            return res.redirect(referer);
        }

        const deleteQuery = 'DELETE FROM reviews WHERE reviewid = $1';
        const result = await pool.query(deleteQuery, [reviewId]);

        if (result.rowCount > 0) {
            req.flash('success', `Отзыв ID: ${reviewId} успешно удален администратором.`);
        } else {
            req.flash('error', `Отзыв с ID: ${reviewId} не найден или был удален ранее.`);
        }

    } catch (e) {
        console.error('Ошибка при удалении отзыва администратором:', e);
        req.flash('error', 'Произошла ошибка сервера при удалении отзыва.');
    }

    res.redirect(referer);
});

// --- МАРШРУТЫ ДЛЯ РЕЖИССЕРОВ ---
// 1. GET /admin/edit-director/:directorid? - Рендер страницы добавления/редактирования режиссера
router.get('/edit-director/:directorid?', async (req, res) => {
    const directorId = req.params.directorid;
    let directorData = req.flash('directorData')[0] || {};
    const isEdit = !!directorId;

    try {
        if (isEdit) {
            const result = await pool.query('SELECT directorid, name, photourl, birthdate, biography FROM directors WHERE directorid = $1', [directorId]);
            if (result.rows.length === 0) {
                req.flash('error', `Режиссер с ID ${directorId} не найден.`);
                return res.redirect('/');
            }
            // Используем данные из БД или ранее сохраненные флеш-данные
            directorData = req.flash('directorData')[0] || result.rows[0];

            if (directorData.birthdate) {
                // Преобразование в формат YYYY-MM-DD для поля input type="date"
                directorData.birthdate = new Date(directorData.birthdate).toISOString().substring(0, 10);
            } else {
                directorData.birthdate = '';
            }
        }

        res.render('admin/edit-director', {
            title: isEdit ? `Редактировать режиссера: ${directorData.name || 'Неизвестно'}` : 'Добавить нового режиссера',
            isEdit,
            director: directorData,
            error: req.flash('error'),
            success: req.flash('success')
        });

    } catch (e) {
        console.error('Ошибка получения данных режиссера:', e);
        req.flash('error', 'Ошибка сервера при загрузке данных режиссера.');
        res.redirect('/');
    }
});

// 1. POST /admin/edit-director/:directorid? - Обработка формы добавления/редактирования режиссера
router.post('/edit-director/:directorid?', (req, res, next) => {
        const directorId = req.params.directorid;
        const redirectUrl = directorId ? `/admin/edit-director/${directorId}` : '/admin/edit-director';

        uploadDirectorPhoto(req, res, (err) => {
            if (err) {
                const errorMessage = err instanceof multer.MulterError ?
                    `Ошибка загрузки фото: ${err.message}. Макс. размер 5MB.` :
                    `Критическая ошибка файла: ${err.message}`;
                req.flash('error', errorMessage);
                req.flash('directorData', req.body);
                return res.redirect(redirectUrl);
            }
            next();
        });
    },
    directorValidators,
    async (req, res) => {
        const directorId = req.params.directorid;
        const isEdit = !!directorId;
        const redirectUrl = directorId ? `/admin/edit-director/${directorId}` : '/admin/edit-director';

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

        // ИЗМЕНЕНИЕ: Удалили photourl из деструктуризации, так как используется локальная загрузка (req.file)
        const { name, birthdate, biography, currentPhotourl } = req.body;

        let newPhotoUrl = req.file ? `/uploads/directors/${req.file.filename}` : null;
        let oldPhotoPath = null;

        // ИЗМЕНЕНИЕ: Удалили photourl из финальной логики
        let finalPhotoUrl = newPhotoUrl || currentPhotourl || null;

        try {
            if (isEdit) {
                if (newPhotoUrl) {
                    const oldDirectorResult = await pool.query('SELECT photourl FROM directors WHERE directorid = $1', [directorId]);
                    if (oldDirectorResult.rows.length > 0) {
                        oldPhotoPath = oldDirectorResult.rows[0].photourl;
                    }
                }

                const updateQuery = `
                    UPDATE directors 
                    SET name = $1, biography = $2, birthdate = $3, photourl = $4
                    WHERE directorid = $5
                `;

                await pool.query(updateQuery, [name, biography, birthdate || null, finalPhotoUrl, directorId]);

                // Дополнительная проверка на внешний URL перед удалением
                if (newPhotoUrl && oldPhotoPath && !oldPhotoPath.startsWith('http')) {
                    if (oldPhotoPath !== newPhotoUrl) {
                        const absolutePath = path.join(__dirname, '..', 'public', oldPhotoPath);
                        fs.unlink(absolutePath, (err) => {
                            if (err) console.error('Не удалось удалить старое фото:', err);
                        });
                    }
                }

                req.flash('success', `Профиль режиссера "${name}" успешно обновлен.`);

            } else { // Логика добавления нового режиссера
                if (!newPhotoUrl) {
                    req.flash('error', 'Ошибка: Для добавления нового режиссера необходимо загрузить фото.');
                    req.flash('directorData', req.body);
                    return res.redirect(redirectUrl);
                }

                const insertQuery = `
                    INSERT INTO directors (name, biography, birthdate, photourl)
                    VALUES ($1, $2, $3, $4) 
                    RETURNING directorid;
                `;

                const result = await pool.query(insertQuery, [name, biography, birthdate || null, finalPhotoUrl]);
                const newDirectorId = result.rows[0].directorid;
                req.flash('success', `Режиссер "${name}" успешно добавлен.`);
                return res.redirect(`/admin/edit-director/${newDirectorId}`);
            }

            res.redirect(redirectUrl);

        } catch (e) {
            console.error('Ошибка сохранения данных режиссера:', e);
            if (req.file && req.file.path) {
                fs.unlink(req.file.path, (err) => {
                    if (err) console.error('Не удалось удалить загруженный файл после ошибки БД:', err);
                });
            }

            req.flash('error', 'Произошла ошибка сервера при сохранении режиссера.');
            req.flash('directorData', req.body);
            res.redirect(redirectUrl);
        }
    }
);

// 2. POST /admin/delete-director/:directorid - Удаление режиссера
router.post('/delete-director/:directorid', async (req, res) => {
    const directorId = req.params.directorid;
    const redirectBackUrl = `/admin/edit-director/${directorId}`;

    try {
        const movieCheck = await pool.query('SELECT COUNT(*) FROM movies WHERE directorid = $1', [directorId]);
        const movieCount = parseInt(movieCheck.rows[0].count, 10);

        if (movieCount > 0) {
            req.flash('error', `Невозможно удалить режиссера с ID ${directorId}, так как в базе числится ${movieCount} связанных фильмов. Сначала отредактируйте или удалите фильмы.`);
            return res.redirect(redirectBackUrl);
        }

        const directorResult = await pool.query('SELECT photourl FROM directors WHERE directorid = $1', [directorId]);
        if (directorResult.rows.length === 0) {
            req.flash('error', 'Режиссер для удаления не найден.');
            return res.redirect('/');
        }
        const photoUrl = directorResult.rows[0].photourl;

        await pool.query('DELETE FROM directors WHERE directorid = $1', [directorId]);

        if (photoUrl) {
            const absolutePath = path.join(__dirname, '..', 'public', photoUrl);
            fs.unlink(absolutePath, (err) => {
                if (err) console.error('Не удалось удалить фото режиссера:', err);
            });
        }

        req.flash('success', 'Режиссер и его данные успешно удалены.');
        res.redirect('/');

    } catch (e) {
        console.error('Ошибка удаления режиссера:', e);
        req.flash('error', 'Произошла ошибка сервера при удалении режиссера.');
        res.redirect(redirectBackUrl);
    }
});


// GET /admin/sessions - Отображение списка сеансов и формы добавления
router.get('/sessions', async (req, res) => {
    try {
        const moviesQuery = `
            SELECT movieid, title, price 
            FROM movies 
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
                s.iscancelled
            FROM screenings s
            JOIN movies m ON s.movieid = m.movieid
            JOIN halls h ON s.hallid = h.hallid
            WHERE s.starttime >= NOW() - INTERVAL '1 hour'
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
router.post('/sessions', [
    body('movieId', 'Необходимо выбрать фильм.').isInt().toInt(),
    body('hallId', 'Необходимо выбрать зал.').isInt().toInt(),
    body('startTime', 'Некорректная дата и время.').isISO8601(),
], async (req, res) => {
    const errors = validationResult(req);
    const { movieId, hallId, startTime } = req.body;

    if (!errors.isEmpty()) {
        req.flash('error', errors.array()[0].msg);
        req.flash('formData', req.body);
        return req.session.save(() => res.redirect('/admin/sessions'));
    }

    try {
        // 1. Получаем длительность фильма
        const { rows: movieInfo } = await pool.query('SELECT durationmin FROM movies WHERE movieid = $1', [movieId]);
        if (movieInfo.length === 0) {
            req.flash('error', 'Выбранный фильм не найден.');
            return req.session.save(() => res.redirect('/admin/sessions'));
        }

        const newMovieDurationMin = movieInfo[0].durationmin;
        // Полная длительность блока (фильм + уборка) в мс
        const newSessionFullDurationMs = (newMovieDurationMin * 60000) + CLEANING_TIME_MS;

        // --- ПОДГОТОВКА ДАТ ---
        const requestedStart = new Date(startTime);
        // Время окончания запрашиваемого сеанса (с уборкой)
        const requestedEndMs = requestedStart.getTime() + newSessionFullDurationMs;

        const dayStart = new Date(requestedStart);
        dayStart.setHours(DAY_START_HOUR, 0, 0, 0);

        const dayEndLimit = new Date(requestedStart);
        dayEndLimit.setHours(LATEST_START_HOUR, 0, 0, 0);

        // Проверка на выход за границы рабочего дня (9:00 - 21:00)
        if (requestedStart.getTime() > dayEndLimit.getTime() || requestedStart.getTime() < dayStart.getTime()) {
            req.flash('error', `Сеанс должен начинаться в рабочее время (${DAY_START_HOUR}:00 - ${LATEST_START_HOUR}:00).`);
            req.flash('formData', req.body);
            return req.session.save(() => res.redirect('/admin/sessions'));
        }

        // 2. ПОЛУЧАЕМ ВСЕ СУЩЕСТВУЮЩИЕ СЕАНСЫ НА ЭТОТ ДЕНЬ
        const allSessionsQuery = `
            SELECT 
                s.screeningid,
                s.starttime,
                m.durationmin
            FROM screenings s
            JOIN movies m ON s.movieid = m.movieid
            WHERE s.hallid = $1 
            AND s.iscancelled = FALSE 
            AND s.starttime >= $2::timestamp 
            AND s.starttime <= $3::timestamp 
            ORDER BY s.starttime ASC; 
        `;

        // Интервал для поиска: весь день
        const searchDayStart = new Date(requestedStart); searchDayStart.setHours(0,0,0,0);
        const searchDayEnd = new Date(requestedStart); searchDayEnd.setHours(23,59,59,999);

        const { rows: existingSessions } = await pool.query(allSessionsQuery, [hallId, searchDayStart.toISOString(), searchDayEnd.toISOString()]);

        // 3. ПРОВЕРКА КОНФЛИКТА
        let collisionFound = false;

        for (let i = 0; i < existingSessions.length; i++) {
            const session = existingSessions[i];
            const existStartMs = new Date(session.starttime).getTime();
            // Конец существующего сеанса = старт + фильм + уборка
            const existEndMs = existStartMs + (session.durationmin * 60000) + CLEANING_TIME_MS;

            // Условие пересечения (Стандартная формула пересечения отрезков)
            if (requestedStart.getTime() < existEndMs && existStartMs < requestedEndMs) {
                collisionFound = true;
                break;
            }
        }

        // --- ЕСЛИ ЕСТЬ КОНФЛИКТ, ЗАПУСКАЕМ ГЛОБАЛЬНЫЙ ПОИСК ОКОН ---
        if (collisionFound) {

            let suggestions = [];
            let slotsFoundCount = 0;

            // Курсор начала свободного окна. Изначально - открытие кинотеатра.
            let windowStartMs = dayStart.getTime();

            // Проходимся по всем сеансам + 1 итерация для "окна после последнего сеанса"
            for (let i = 0; i <= existingSessions.length; i++) {
                let windowEndMs;

                if (i < existingSessions.length) {
                    // Если сеанс есть, окно заканчивается началом этого сеанса
                    windowEndMs = new Date(existingSessions[i].starttime).getTime();
                } else {
                    // Если сеансы кончились, окно заканчивается временем закрытия (последний старт)
                    windowEndMs = dayEndLimit.getTime();
                }

                // Длительность текущего "окна"
                const gapSize = windowEndMs - windowStartMs;

                let fits = false;
                if (i === existingSessions.length) {
                    // Последний слот (вечер): проверяем, не поздно ли начинать
                    if (windowStartMs <= dayEndLimit.getTime()) {
                        fits = true;
                    }
                } else {
                    // Промежуточный слот: проверяем, влезет ли фильм + уборка ДО начала следующего
                    if (gapSize >= newSessionFullDurationMs) {
                        fits = true;
                    }
                }

                if (fits) {
                    // 1. ПРЕДЛОЖЕНИЕ "РАНО" (В начале окна)
                    let earlyStart = new Date(windowStartMs);
                    earlyStart = roundToNearestFiveMinutes(earlyStart);

                    // Проверка после округления: не уехали ли мы вперед, создав конфликт?
                    if (i < existingSessions.length) {
                        if (earlyStart.getTime() + newSessionFullDurationMs > windowEndMs) {
                            // Если округление вытолкнуло нас за границы, слот не подходит (слишком тесно)
                            // Или можно попробовать отступить назад, но тут мы идем от начала.
                        } else {
                            const tStr = earlyStart.toLocaleTimeString('ru-RU', {hour: '2-digit', minute:'2-digit'});
                            suggestions.push(`${tStr}`);
                            slotsFoundCount++;
                        }
                    } else {
                        // Вечерний слот: просто проверяем лимит
                        if (earlyStart.getTime() <= dayEndLimit.getTime()) {
                            const tStr = earlyStart.toLocaleTimeString('ru-RU', {hour: '2-digit', minute:'2-digit'});
                            suggestions.push(`${tStr}`);
                            slotsFoundCount++;
                        }
                    }

                    if (i < existingSessions.length) {
                        let lateStartMs = windowEndMs - newSessionFullDurationMs;

                        // Если разница между началом окна и поздним стартом существенная (например, > 15 минут)
                        if (lateStartMs - windowStartMs > 15 * 60000) {
                            let lateStart = new Date(lateStartMs);
                            lateStart = roundToNearestFiveMinutes(lateStart);

                            // КОРРЕКЦИЯ: Округление могло кинуть нас ВПЕРЕД, наехав на след. сеанс
                            if (lateStart.getTime() + newSessionFullDurationMs > windowEndMs) {
                                lateStart.setMinutes(lateStart.getMinutes() - 5);
                            }

                            // Проверяем, не уехали ли мы назад за начало окна
                            if (lateStart.getTime() >= windowStartMs) {
                                const tStr = lateStart.toLocaleTimeString('ru-RU', {hour: '2-digit', minute:'2-digit'});
                                suggestions.push(`${tStr}`);
                                slotsFoundCount++;
                            }
                        }
                    }
                }

                // ОБНОВЛЯЕМ КУРСОР НАЧАЛА СЛЕДУЮЩЕГО ОКНА
                if (i < existingSessions.length) {
                    // Конец текущего сеанса + уборка = Начало следующего свободного окна
                    windowStartMs = new Date(existingSessions[i].starttime).getTime() + (existingSessions[i].durationmin * 60000) + CLEANING_TIME_MS;
                }

                if (slotsFoundCount >= 4) break; // Хватит предложений
            }

            if (suggestions.length === 0) {
                req.flash('error', `Конфликт! В этот день нет свободного времени для фильма длительностью ${newMovieDurationMin} мин (+${CLEANING_TIME_MINUTES} мин уборка).`);
            } else {
                // Убираем дубликаты (Set) и сортируем
                const uniqueSuggestions = [...new Set(suggestions)].sort();
                req.flash('error', `Конфликт расписания! Свободные слоты: ${uniqueSuggestions.join(', ')}.`);
            }

            req.flash('formData', req.body);
            return req.session.save(() => res.redirect('/admin/sessions'));
        }

        // === ЕСЛИ КОНФЛИКТОВ НЕТ, СОЗДАЕМ СЕАНС ===
        const insertQuery = `
            INSERT INTO screenings (movieid, hallid, starttime)
            VALUES ($1, $2, $3)
            RETURNING screeningid;
        `;
        await pool.query(insertQuery, [movieId, hallId, startTime]);

        req.flash('success', 'Сеанс успешно создан!');
        req.session.save(() => res.redirect('/admin/sessions'));

    } catch (e) {
        console.error('Ошибка при создании сеанса:', e);
        if (e.code === '23505') {
            req.flash('error', 'Дубликат сеанса (возможно, в базе есть скрытый отмененный сеанс).');
        } else {
            req.flash('error', 'Произошла ошибка сервера.');
        }
        req.flash('formData', req.body);
        await req.session.save(() => res.redirect('/admin/sessions'));
    }
});

// POST /admin/sessions/:id/cancel - Отмена сеанса
router.post('/sessions/:id/cancel', async (req, res) => {
    const screeningId = req.params.id;

    try {
        const cancelQuery = `
            UPDATE screenings 
            SET iscancelled = TRUE 
            WHERE screeningid = $1 AND starttime >= NOW()
            RETURNING movieid;
        `;
        const { rows } = await pool.query(cancelQuery, [screeningId]);

        if (rows.length === 0) {
            req.flash('error', 'Сеанс либо не найден, либо уже прошел, либо уже отменен.');
            return req.session.save(() => res.redirect('/admin/sessions'));
        }

        req.flash('success', `Сеанс фильма ID ${rows[0].movieid} успешно отменен. Все бронирования/билеты отмечены как 'Возвращен'.`);
        req.session.save(() => res.redirect('/admin/sessions'));

    } catch (e) {
        console.error(`Ошибка при отмене сеанса ${screeningId}:`, e);
        req.flash('error', 'Критическая ошибка при отмене сеанса.');
        req.session.save(() => res.redirect('/admin/sessions'));
    }
});

// GET /admin/add-short - Рендер страницы добавления короткого видео
router.get('/add-short', async (req, res) => {
    try {
        // Получаем список всех фильмов для выбора, к какому привязать видео
        const { rows: movies } = await pool.query('SELECT movieid, title FROM movies ORDER BY title');

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
router.post('/add-short', (req, res, next) => {
        // Используем настроенный Multer для видео
        uploadShortVideo(req, res, (err) => {
            if (err) {
                const errorMessage = err instanceof multer.MulterError ?
                    `Ошибка загрузки видео: ${err.message}. Макс. размер 20MB.` :
                    `Критическая ошибка файла: ${err.message}`;
                req.flash('error', errorMessage);
                req.flash('formData', req.body);
                return res.redirect('/admin/add-short');
            }
            next();
        });
    },
    [
        // Простая валидация
        body('movieId', 'Необходимо выбрать фильм.').isInt().toInt(),
        body('title', 'Заголовок должен быть не менее 2 символов.').isLength({ min: 2 }).trim(),
        body('durationsec', 'Длительность должна быть числом (секунды).').isInt({ min: 1, max: 180 }).toInt() // Ограничим до 180с
    ],
    async (req, res) => {
        const errors = validationResult(req);
        const { movieId, title, durationsec } = req.body;

        // Проверка на отсутствие файла (для нового видео он обязателен)
        if (!req.file) {
            if (errors.isEmpty()) { // Если ошибок валидации нет, но нет файла
                req.flash('error', 'Ошибка: Не выбран видеофайл.');
                req.flash('formData', req.body);
                return res.redirect('/admin/add-short');
            }
        }

        if (!errors.isEmpty()) {
            if (req.file && req.file.path) {
                fs.unlink(req.file.path, (err) => {
                    if (err) console.error('Не удалось удалить загруженный файл после ошибки валидации:', err);
                });
            }
            req.flash('error', errors.array()[0].msg);
            req.flash('formData', req.body);
            return res.status(422).redirect('/admin/add-short');
        }

        // Путь к файлу в public директории
        const videoPath = `/uploads/shorts/${req.file.filename}`;

        try {
            const insertQuery = `
                INSERT INTO shorts (movieid, title, videopath, durationsec)
                VALUES ($1, $2, $3, $4) 
                RETURNING shortid;
            `;

            await pool.query(insertQuery, [movieId, title, videoPath, durationsec]);

            req.flash('success', `Короткое видео "${title}" успешно добавлено.`);
            res.redirect('/admin/add-short');

        } catch (e) {
            console.error('Ошибка добавления короткого видео:', e);
            if (req.file && req.file.path) {
                fs.unlink(req.file.path, (err) => {
                    if (err) console.error('Не удалось удалить загруженный файл после ошибки БД:', err);
                });
            }

            req.flash('error', 'Произошла ошибка сервера при сохранении видео.');
            req.flash('formData', req.body);
            res.redirect('/admin/add-short');
        }
    }
);


module.exports = router;