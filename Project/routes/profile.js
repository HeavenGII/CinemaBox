const { Router } = require('express');
const router = Router();
const { body, validationResult } = require('express-validator');
const authMiddleware = require('../middleware/auth');
const pool = require('../db');
const QRCode = require('qrcode');
const crypto = require('crypto');

router.use(authMiddleware);

// GET /profile - Рендер страницы профиля (Управление учетной записью)
router.get('/', async (req, res) => {
    const userId = req.session.user.userId;
    try {
        const userResult = await pool.query(
            `SELECT 
                email, nickname, firstname, lastname, phone, role, 
                telegramid, enablenotifications, telegramlinktoken 
            FROM users WHERE userid = $1`,
            [userId]
        );
        const profileData = userResult.rows[0];

        if (!profileData) {
            // ✅ ИСПРАВЛЕНО
            throw new Error("Профиль пользователя не найден.");
        }

        const success = req.flash('success');
        const error = req.flash('error');
        const userData = req.flash('userData')[0] || {};

        const userDisplayData = {
            email: userData.email || profileData.email,
            nickname: userData.nickname || profileData.nickname,
            firstName: userData.firstName || profileData.firstname,
            lastName: userData.lastName || profileData.lastname,
            phone: userData.phone || profileData.phone,
            role: profileData.role,
            telegramId: userData.telegramId || profileData.telegramid,
            telegramLinkToken: profileData.telegramlinktoken,
            enableNotifications: userData.enableNotifications !== undefined
                ? userData.enableNotifications
                : profileData.enablenotifications,
        };

        if (typeof userDisplayData.enableNotifications === 'string') {
            userDisplayData.enableNotifications = userDisplayData.enableNotifications === 'true';
        }

        res.render('profile/profile', {
            title: 'Мой Профиль',
            isProfile: true,
            user: userDisplayData,
            success: success.length ? success[0] : null,
            error: error.length ? error[0] : null,
            // csrfToken: req.csrfToken()
        });

    } catch (e) {
        console.error('Ошибка при загрузке профиля:', e);
        req.flash('error', 'Не удалось загрузить данные профиля.');
        res.redirect('/');
    }
});

router.post('/telegram/generate-token', async (req, res) => {
    const userId = req.session.user.userId;

    // Генерируем уникальный токен (32 символа)
    const linkToken = crypto.randomBytes(16).toString('hex');

    try {
        // Сохраняем токен, только если Telegram ID еще не установлен
        const updateQuery = `
            UPDATE users
            SET telegramlinktoken = $1
            WHERE userid = $2 AND telegramid IS NULL
            RETURNING telegramlinktoken;
        `;
        const { rows } = await pool.query(updateQuery, [linkToken, userId]);

        if (rows.length === 0) {
            return res.status(400).json({ error: 'Аккаунт Telegram уже привязан или не найден.' });
        }

        console.log(`[Telegram Link] Токен ${linkToken} сгенерирован для пользователя ${userId}.`);

        res.status(200).json({
            success: true,
            token: linkToken,
            message: 'Код привязки успешно сгенерирован.'
        });

    } catch (e) {
        console.error('Ошибка генерации токена Telegram:', e);
        res.status(500).json({ error: 'Ошибка сервера при создании токена.' });
    }
});


const profileUpdateValidators = [
    body('nickname', 'Никнейм должен быть не менее 2 символов.').isLength({ min: 2 }).trim()
        .custom(async (value, { req }) => {
            const userId = req.session.user.userId;
            const userResult = await pool.query('SELECT 1 FROM users WHERE nickname = $1 AND userid != $2', [value, userId]);
            if (userResult.rows.length > 0) {
                return Promise.reject('Этот никнейм уже занят другим пользователем.');
            }
        }),
    body('firstName').optional({ checkFalsy: true }).trim(),
    body('lastName').optional({ checkFalsy: true }).trim(),
    body('phone').optional({ checkFalsy: true }).trim(),

    body('telegramId')
        .optional({ checkFalsy: true })
        .trim()
        .isNumeric().withMessage('Telegram ID должен быть числом.')
        .isLength({ min: 5, max: 20 }).withMessage('Telegram ID не соответствует требуемому формату (слишком короткий или длинный).')
];


// POST /profile/update - Логика обновления данных пользователя
router.post('/update', profileUpdateValidators, async (req, res) => {
    const {
        firstName,
        lastName,
        phone,
        nickname,
        telegramId, // Придет, только если аккаунт привязан
        enableNotifications
    } = req.body;

    const userId = req.session.user.userId;
    const errors = validationResult(req);

    // Нотификации включаются только если чекбокс 'on' и telegramId НЕ NULL
    const isNotificationsEnabled = enableNotifications === 'on' && !!telegramId;

    const userData = {
        nickname, firstName, lastName, phone, telegramId, enableNotifications: isNotificationsEnabled
    };

    if (!errors.isEmpty()) {
        req.flash('error', errors.array()[0].msg);
        req.flash('userData', userData);
        return res.status(422).redirect('/profile');
    }

    try {
        const updateQuery = `
            UPDATE users SET 
                nickname = $1, 
                firstname = $2, 
                lastname = $3, 
                phone = $4,
                telegramid = COALESCE($5::BIGINT, telegramid),
                enablenotifications = $6
            WHERE userid = $7
            RETURNING nickname, firstname, lastname, phone, telegramid, enablenotifications;
        `;

        // Преобразуем telegramId в BIGINT или оставляем null
        const telegramIdValue = telegramId ? String(telegramId) : null;

        const updateResult = await pool.query(updateQuery, [
            nickname,
            firstName,
            lastName,
            phone || null,
            telegramIdValue,
            isNotificationsEnabled,
            userId
        ]);

        if (updateResult.rows[0]) {
            // Обновляем сессию
            const updated = updateResult.rows[0];
            req.session.user = {
                ...req.session.user,
                nickname: updated.nickname,
                firstName: updated.firstname,
                lastName: updated.lastname,
                phone: updated.phone,
                telegramId: updated.telegramid,
                enableNotifications: updated.enablenotifications,
            };
        }

        req.flash('success', 'Данные профиля успешно обновлены!');
        req.session.save(() => res.redirect('/profile'));

    } catch (e) {
        console.error('Ошибка обновления профиля:', e);
        req.flash('error', 'Ошибка обновления данных. Проверьте корректность введенных значений.');
        res.redirect('/profile');
    }
});


// GET /profile/delete - Рендер страницы подтверждения удаления
router.get('/delete', async (req, res) => {
    const userId = req.session.user.userId;

    try {
        const userResult = await pool.query(
            `SELECT email FROM users WHERE userid = $1`,
            [userId]
        );
        const profileData = userResult.rows[0];

        if (!profileData) {
            req.flash('error', 'Ошибка: профиль не найден.');
            return res.redirect('/profile');
        }

        res.render('profile/delete', {
            title: 'Удаление аккаунта',
            isProfile: true,
            userEmail: profileData.email,
            error: req.flash('error'),
            // csrfToken: req.csrfToken()
        });

    } catch (e) {
        console.error('Ошибка загрузки страницы удаления:', e);
        req.flash('error', 'Произошла ошибка при подготовке к удалению.');
        res.redirect('/profile');
    }
});


// POST /profile/delete - Логика выполнения удаления аккаунта
router.post('/delete', async (req, res) => {
    const userId = req.session.user.userId;

    try {

        const deleteQuery = 'DELETE FROM users WHERE userid = $1 RETURNING userid;';
        const result = await pool.query(deleteQuery, [userId]);

        if (result.rowCount === 0) {
            req.flash('error', 'Не удалось удалить аккаунт или он уже был удален.');
            return res.redirect('/profile');
        }

        req.session.destroy(() => {
            res.cookie('deleteSuccess', 'Ваш аккаунт был успешно удален.', { maxAge: 10000 });
            res.redirect('/auth/login');
        });

    } catch (e) {
        console.error('Ошибка удаления аккаунта:', e);
        req.flash('error', 'Критическая ошибка сервера при удалении аккаунта.');
        res.redirect('/profile/delete');
    }
});


router.get('/tickets', authMiddleware, async (req, res) => {
    const userId = req.session.user.userId;

    try {
        const query = `
            SELECT
                t.ticketid,
                t.rownum,
                t.seatnum,
                t.totalprice,
                t.status,
                s.starttime,
                m.title AS movie_title,
                h.name AS hall_name
            FROM tickets t
            JOIN screenings s ON t.screeningid = s.screeningid
            JOIN movies m ON s.movieid = m.movieid
            JOIN halls h ON s.hallid = h.hallid
            WHERE t.userid = $1 AND t.status = 'Оплачен' 
            ORDER BY s.starttime DESC;
        `;
        const result = await pool.query(query, [userId]);

        const ticketsWithFlags = result.rows.map(ticket => {
            const isCancellableStatus = ticket.status === 'Оплачен';
            return {
                ...ticket,
                isCancellableStatus: isCancellableStatus
            };
        });

        res.render('profile/tickets', {
            title: 'Мои билеты',
            isTickets: true,
            tickets: ticketsWithFlags,
            error: req.flash('error')[0] || null,
            success: req.flash('success')[0] || null,
            // csrfToken: req.csrfToken() // Если вы используете CSRF
        });

    } catch (e) {
        console.error('Ошибка при загрузке билетов:', e);
        req.flash('error', 'Не удалось загрузить ваши активные билеты.');
        res.redirect('/');
    }
});


// GET /profile/ticket/:id - Страница с деталями конкретного билета (ОБНОВЛЕНО)
router.get('/ticket/:id', authMiddleware, async (req, res) => {
    const ticketId = req.params.id;
    const userId = req.session.user.userId;

    try {
        const ticketDetailQuery = `
            SELECT 
                t.ticketid, t.rownum, t.seatnum, t.totalprice, t.status, t.qrtoken,  
                s.screeningid, s.starttime,
                m.title AS movie_title, m.posterurl,
                h.name AS hall_name, h.rowscount, h.seatsperrow
            FROM tickets t
            JOIN screenings s ON t.screeningid = s.screeningid
            JOIN movies m ON s.movieid = m.movieid
            JOIN halls h ON s.hallid = h.hallid
            WHERE t.ticketid = $1 AND t.userid = $2;
        `;
        const ticketResult = await pool.query(ticketDetailQuery, [ticketId, userId]);
        const ticket = ticketResult.rows[0];

        if (!ticket) {
            req.flash('error', `Билет №${ticketId} не найден или не принадлежит вам.`);
            return req.session.save(() => res.redirect('/profile/tickets'));
        }

        const bookedSeatsQuery = `
            SELECT rownum, seatnum
            FROM tickets
            WHERE screeningid = $1 AND status IN ('Забронирован', 'Оплачен', 'Использован')
            AND ticketid != $2; 
        `;
        const { rows: bookedSeats } = await pool.query(bookedSeatsQuery, [ticket.screeningid, ticket.ticketid]);

        const bookedSeatKeys = bookedSeats.map(seat => `${seat.rownum}-${seat.seatnum}`);

        let qrCodeDataUrl = '';
        if (ticket.qrtoken) {
            const qrData = ticket.qrtoken;
            qrCodeDataUrl = await QRCode.toDataURL(qrData, {
                errorCorrectionLevel: 'H',
                type: 'image/png',
                margin: 1,
                width: 200
            });
        }

        res.render('profile/ticket-details', {
            title: `Билет на ${ticket.movie_title}`,
            isTickets: true,
            ticket: {
                ...ticket,
                qrCodeUrl: qrCodeDataUrl
            },
            bookedSeatKeysJson: JSON.stringify(bookedSeatKeys),
            userSeatKey: `${ticket.rownum}-${ticket.seatnum}`
        });

    } catch (e) {
        console.error(`Ошибка при загрузке деталей билета ID ${ticketId}:`, e);
        req.flash('error', 'Не удалось загрузить детали билета.');
        res.redirect('/profile/tickets');
    }
});


// POST /profile/ticket/:id/cancel - Логика отказа от билета (Возврат)
router.post('/ticket/:id/cancel', authMiddleware, async (req, res) => {
    const ticketId = req.params.id;
    const userId = req.session.user.userId;
    const cancellationDeadline = 120;

    try {
        const checkQuery = `
            SELECT s.starttime, t.status
            FROM tickets t
            JOIN screenings s ON t.screeningid = s.screeningid
            WHERE t.ticketid = $1 AND t.userid = $2;
        `;
        const checkResult = await pool.query(checkQuery, [ticketId, userId]);
        const ticketInfo = checkResult.rows[0];

        if (!ticketInfo) {
            req.flash('error', `Билет №${ticketId} не найден или не принадлежит вам.`);
        }
        else if (ticketInfo.status !== 'Оплачен') {
            req.flash('error', `Билет №${ticketId} не может быть отменен, так как имеет статус "${ticketInfo.status}". Отменить можно только оплаченный билет.`);
        }
        else {
            const startTime = new Date(ticketInfo.starttime);
            const deadline = new Date(startTime.getTime() - cancellationDeadline * 60000);

            if (new Date() > deadline) {
                req.flash('error', `Срок отмены билета №${ticketId} истек. Отмена возможна не позднее чем за ${cancellationDeadline} минут (2 часа) до сеанса.`);
            } else {
                const cancelQuery = `
                    UPDATE tickets
                    SET status = 'Возвращен'
                    WHERE ticketid = $1 AND userid = $2 AND status = 'Оплачен'
                    RETURNING ticketid;
                `;

                const result = await pool.query(cancelQuery, [ticketId, userId]);

                if (result.rowCount > 0) {
                    req.flash('success', `Билет №${ticketId} успешно отменен (возвращен).`);
                } else {
                    req.flash('error', `Не удалось отменить билет №${ticketId}.`);
                }
            }
        }

        req.session.save(() => res.redirect('/profile/tickets'));

    } catch (e) {
        console.error('Ошибка отмены билета:', e);
        req.flash('error', 'Ошибка сервера при попытке отмены билета.');
        res.redirect('/profile/tickets');
    }
});


module.exports = router;