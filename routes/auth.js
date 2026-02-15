const { Router } = require('express');
const router = Router();
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const pool = require('../db');
const crypto = require('crypto');
const {sendPasswordResetEmail} = require('../services/sendEmail');
const keys = require('../keys');

const isGuest = (req, res, next) => {
    if (req.session.isAuthenticated) {
        return res.redirect('/');
    }
    next();
};


// GET /auth/login - Рендер страницы авторизации
router.get('/login', isGuest, (req, res) => {
    const error = req.flash('loginError');

    res.render('auth/login', {
        title: 'Авторизация',
        isLogin: true,
        error: error.length ? error[0] : null,
    });
});


// GET /auth/register - Рендер страницы регистрации
router.get('/register', isGuest, (req, res) => {
    const error = req.flash('registerError');
    const registerData = req.flash('registerData');

    res.render('auth/register', {
        title: 'Регистрация',
        isRegister: true,
        error: error.length ? error[0] : null,
        registerData: registerData.length ? registerData[0] : {},
    });
});


// POST /auth/login - Логика аутентификации
const loginValidators = [
    body('email', 'Некорректный email').isEmail(),
    body('password', 'Пароль должен быть не менее 6 символов').isLength({ min: 6 }).trim()
];

router.post('/login', isGuest, loginValidators, async (req, res) => {
    const { email, password } = req.body;
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
        req.flash('loginError', errors.array()[0].msg);
        return res.status(422).redirect('/auth/login');
    }

    try {
        const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = userResult.rows[0];
        if (!user) {
            req.flash('loginError', 'Пользователь с таким email не найден.');
            return res.redirect('/auth/login');
        }
        const passwordsMatch = await bcrypt.compare(password, user.password);
        if (passwordsMatch) {
            req.session.user = {
                userId: user.userid,
                email: user.email,
                role: user.role
            };
            req.session.isAuthenticated = true;

            req.session.save(err => {
                if (err) throw err;
                res.redirect('/');
            });
        } else {
            req.flash('loginError', 'Неверный пароль.');
            res.redirect('/auth/login');
        }
    } catch (e) {
        console.error('Login error:', e);
        req.flash('loginError', 'Ошибка авторизации на сервере.');
        res.redirect('/auth/login');
    }
});


// POST /auth/register - Логика регистрации
const registerValidators = [
    body('email').isEmail().withMessage('Введите корректный email.')
        .custom(async (value, { req }) => {
            const userResult = await pool.query('SELECT userid FROM users WHERE email = $1', [value]);
            if (userResult.rows.length > 0) {
                throw new Error('Этот email уже занят.');
            }
            return true;
        }).normalizeEmail(),

    body('nickname', 'Никнейм должен быть не менее 2 символов.').isLength({ min: 2 }).trim()
        .custom(async (value, { req }) => {
            const userResult = await pool.query('SELECT userid FROM users WHERE nickname = $1', [value]);
            if (userResult.rows.length > 0) {
                throw new Error('Этот никнейм уже занят.');
            }
            return true;
        }),

    body('password', 'Пароль должен быть минимум 6 символов.').isLength({ min: 6 }).trim(),

    body('confirm').custom((value, { req }) => {
        if (value !== req.body.password) {
            throw new Error('Пароли не совпадают.');
        }
        return true;
    }).trim()
];

router.post('/register', isGuest, registerValidators, async (req, res) => {
    const { email, nickname, password, firstName, lastName, phone } = req.body;
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
        req.flash('registerError', errors.array()[0].msg);
        req.flash('registerData', { email, nickname, firstName, lastName, phone });
        return res.status(422).redirect('/auth/register');
    }

    try {
        const hashPassword = await bcrypt.hash(password, 10);

        // Вставляем пользователя с явным указанием ID (используем MAX + 1)
        const insertQuery = `
            INSERT INTO users (userid, email, nickname, password, firstname, lastname, phone, role)
            VALUES (
                (SELECT COALESCE(MAX(userid), 0) + 1 FROM users),
                $1, $2, $3, $4, $5, $6, 'Пользователь'
            )
            RETURNING userid`;

        const result = await pool.query(insertQuery, [
            email,
            nickname,
            hashPassword,
            firstName || null,
            lastName || null,
            phone || null
        ]);

        console.log('✅ Новый пользователь зарегистрирован. ID:', result.rows[0].userid);
        res.redirect('/auth/login');

    } catch (e) {
        console.error('Registration failed:', e);

        if (e.code === '23505') {
            if (e.detail.includes('email')) {
                req.flash('registerError', 'Этот email уже используется.');
            } else if (e.detail.includes('nickname')) {
                req.flash('registerError', 'Этот никнейм уже используется.');
            } else if (e.detail.includes('phone')) {
                req.flash('registerError', 'Этот телефон уже используется.');
            } else {
                req.flash('registerError', 'Ошибка уникальности данных.');
            }
        } else {
            req.flash('registerError', 'Ошибка регистрации на сервере.');
        }

        req.flash('registerData', { email, nickname, firstName, lastName, phone });
        res.redirect('/auth/register');
    }
});


// POST /auth/logout - Выход из системы
router.post('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/auth/login');
    });
});

// GET /auth/forgot-password - Показывает форму ввода email
router.get('/forgot-password', (req, res) => {
    res.render('auth/forgot-password', {
        title: 'Забыли пароль',
        error: req.flash('error')[0],
        success: req.flash('success')[0]
    });
});

// POST /auth/forgot-password - Обрабатывает запрос на сброс
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;

    const userResult = await pool.query('SELECT userid, email FROM users WHERE email = $1', [email]);
    const user = userResult.rows[0];

    if (!user) {
        req.flash('success', 'Если ваш адрес электронной почты есть в нашей базе, вы получите письмо со ссылкой для сброса пароля.');
        return res.redirect('/auth/forgot-password');
    }

    try {
        const token = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 3600000);
        await pool.query(
            'UPDATE users SET resetpasswordtoken = $1, resetpasswordexpires = $2 WHERE userid = $3',
            [token, expires, user.userid]
        );
        await sendPasswordResetEmail(user.email, token);

        req.flash('success', 'Письмо со ссылкой для сброса пароля отправлено на вашу почту.');

    } catch (e) {
        console.error('Password reset POST error:', e);
        if (e.code === 'EENVELOPE' || e.code === 'ECONNECTION') {
            req.flash('error', 'Не удалось отправить письмо. Проверьте настройки почтового сервера.');
        } else {
            req.flash('error', 'Произошла ошибка сервера при обработке запроса. Попробуйте позже.');
        }
    }

    res.redirect('/auth/forgot-password');
});

// GET /auth/reset-password - Проверяет токен и показывает форму смены пароля
router.get('/reset-password', async (req, res) => {
    const { token } = req.query;

    if (!token) {
        req.flash('error', 'Отсутствует токен сброса пароля.');
        return res.redirect('/auth/login');
    }

    try {
        const userResult = await pool.query(
            'SELECT userid FROM users WHERE resetpasswordtoken = $1 AND resetpasswordexpires > NOW()',
            [token]
        );

        if (userResult.rows.length === 0) {
            req.flash('error', 'Ссылка недействительна или срок ее действия истек (1 час). Пожалуйста, запросите сброс пароля снова.');
            return res.redirect('/auth/forgot-password');
        }

        res.render('auth/reset-password', {
            title: 'Сброс пароля',
            token: token,
            error: req.flash('error')[0]
        });

    } catch (e) {
        console.error('Password reset GET error:', e);
        req.flash('error', 'Произошла ошибка при проверке токена.');
        res.redirect('/auth/forgot-password');
    }
});

// POST /auth/reset-password - Обновляет пароль
router.post('/reset-password', async (req, res) => {
    const { token, newPassword, confirmPassword } = req.body;

    if (newPassword !== confirmPassword) {
        req.flash('error', 'Пароли не совпадают.');
        return res.redirect(`/auth/reset-password?token=${token}`);
    }
    if (newPassword.length < 6) {
        req.flash('error', 'Пароль должен содержать не менее 6 символов.');
        return res.redirect(`/auth/reset-password?token=${token}`);
    }

    try {
        const userResult = await pool.query(
            'SELECT userid FROM users WHERE resetpasswordtoken = $1 AND resetpasswordexpires > NOW()',
            [token]
        );

        if (userResult.rows.length === 0) {
            req.flash('error', 'Ссылка недействительна или срок ее действия истек.');
            return res.redirect('/auth/forgot-password');
        }

        const userId = userResult.rows[0].userid;

        const hashedPassword = await bcrypt.hash(newPassword, 10);

        await pool.query(
            'UPDATE users SET password = $1, resetpasswordtoken = NULL, resetpasswordexpires = NULL WHERE userid = $2',
            [hashedPassword, userId]
        );

        req.flash('success', 'Пароль успешно изменен! Войдите, используя новый пароль.');
        res.redirect('/auth/login');

    } catch (e) {
        console.error('Password reset POST error:', e);
        req.flash('error', 'Произошла ошибка сервера при сбросе пароля.');
        res.redirect('/auth/forgot-password');
    }
});

module.exports = router;