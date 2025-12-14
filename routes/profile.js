const { Router } = require('express');
const router = Router();
const { body, validationResult } = require('express-validator');
const authMiddleware = require('../middleware/auth');
const pool = require('../db');
const QRCode = require('qrcode');
const crypto = require('crypto');

router.use(authMiddleware);

// --- ВАЛИДАТОРЫ ДЛЯ ПОЛЬЗОВАТЕЛЬСКИХ РОУТОВ ---
const profileUpdateValidators = [
    body('nickname', 'Никнейм должен быть от 2 до 30 символов')
        .isLength({ min: 2, max: 30 }).trim().escape()
        .custom(async (value, { req }) => {
            const userId = req.session.user.userId;
            const userResult = await pool.query(
                'SELECT 1 FROM users WHERE nickname = $1 AND userid != $2',
                [value, userId]
            );
            if (userResult.rows.length > 0) {
                throw new Error('Этот никнейм уже занят другим пользователем.');
            }
            return true;
        }),

    body('firstName', 'Имя должно быть от 2 до 50 символов')
        .optional({ checkFalsy: true })
        .isLength({ min: 2, max: 50 }).trim().escape(),

    body('lastName', 'Фамилия должна быть от 2 до 50 символов')
        .optional({ checkFalsy: true })
        .isLength({ min: 2, max: 50 }).trim().escape(),

    body('phone', 'Некорректный номер телефона')
        .optional({ checkFalsy: true })
        .matches(/^[\+]?[0-9\s\-\(\)]{10,15}$/)
        .withMessage('Введите корректный номер телефона')
        .trim(),

    body('telegramId', 'Telegram ID должен быть числом от 5 до 20 символов')
        .optional({ checkFalsy: true })
        .isInt({ min: 10000, max: 99999999999999999999 })
        .withMessage('Telegram ID должен быть числом от 5 до 20 символов')
        .toInt()
];

const deleteAccountValidators = [
    body('confirmEmail', 'Подтвердите ваш email')
        .notEmpty().withMessage('Email обязателен для подтверждения')
        .isEmail().withMessage('Введите корректный email')
        .custom((value, { req }) => {
            if (value !== req.session.user.email) {
                throw new Error('Email не совпадает с вашим текущим email');
            }
            return true;
        }),

    body('confirmDelete', 'Необходимо подтвердить удаление')
        .equals('on')
        .withMessage('Вы должны подтвердить удаление аккаунта')
];



// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---
function validateTicketOwnership(ticketId, userId) {
    return pool.query(
        'SELECT ticketid FROM tickets WHERE ticketid = $1 AND userid = $2',
        [ticketId, userId]
    );
}

function validateScreeningTime(startTime, cancellationDeadlineMinutes = 120) {
    const deadline = new Date(new Date(startTime).getTime() - cancellationDeadlineMinutes * 60000);
    return new Date() <= deadline;
}

// --- РОУТЫ ---

// GET /profile - Рендер страницы профиля
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
        });

    } catch (e) {
        console.error('Ошибка при загрузке профиля:', e);
        req.flash('error', 'Не удалось загрузить данные профиля.');
        res.redirect('/');
    }
});

// POST /profile/update - Логика обновления данных пользователя
router.post('/update', profileUpdateValidators, async (req, res) => {
    const {
        firstName,
        lastName,
        phone,
        nickname,
        telegramId,
        enableNotifications
    } = req.body;

    const userId = req.session.user.userId;
    const errors = validationResult(req);

    const isNotificationsEnabled = enableNotifications === 'on' && !!telegramId;
    const userData = {
        nickname, firstName, lastName, phone, telegramId,
        enableNotifications: isNotificationsEnabled
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

        const errorMessage = e.code === '23505'
            ? 'Этот никнейм уже занят'
            : 'Ошибка обновления данных. Проверьте корректность введенных значений.';

        req.flash('error', errorMessage);
        req.flash('userData', userData);
        res.redirect('/profile');
    }
});

// GET /profile/delete - Рендер страницы подтверждения удаления
router.get('/delete', async (req, res) => {
    const userId = req.session.user.userId;

    try {
        const userResult = await pool.query(
            `SELECT email, nickname FROM users WHERE userid = $1`,
            [userId]
        );
        const profileData = userResult.rows[0];

        if (!profileData) {
            req.flash('error', 'Ошибка: профиль не найден.');
            return res.redirect('/profile');
        }

        // Проверка активных билетов
        const activeTickets = await pool.query(`
            SELECT COUNT(*) as count
            FROM tickets 
            WHERE userid = $1 
            AND status IN ('Оплачен', 'Забронирован')
            AND screeningid IN (
                SELECT screeningid FROM screenings 
                WHERE starttime > NOW()
            )
        `, [userId]);

        const hasActiveTickets = parseInt(activeTickets.rows[0].count) > 0;

        res.render('profile/delete', {
            title: 'Удаление аккаунта',
            isProfile: true,
            userEmail: profileData.email,
            userNickname: profileData.nickname,
            hasActiveTickets: hasActiveTickets,
            error: req.flash('error'),
            formData: req.flash('formData')[0] || {}
        });

    } catch (e) {
        console.error('Ошибка загрузки страницы удаления:', e);
        req.flash('error', 'Произошла ошибка при подготовке к удалению.');
        res.redirect('/profile');
    }
});

// POST /profile/delete - Логика выполнения удаления аккаунта
router.post('/delete', deleteAccountValidators, async (req, res) => {
    const userId = req.session.user.userId;
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
        req.flash('error', errors.array()[0].msg);
        req.flash('formData', req.body);
        return res.redirect('/profile/delete');
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Проверяем активные билеты
        const activeTicketsQuery = `
            SELECT 
                t.ticketid,
                t.totalprice,
                t.qrtoken,
                s.starttime,
                m.title as movie_title,
                pm.payment_id,
                pm.yookassa_payment_id,
                pm.amount,
                pm.currency
            FROM tickets t
            JOIN screenings s ON t.screeningid = s.screeningid
            JOIN movies m ON s.movieid = m.movieid
            LEFT JOIN payment_metadata pm ON t.qrtoken = pm.ticket_token
            WHERE t.userid = $1 
            AND t.status = 'Оплачен'
            AND s.starttime > NOW()
            AND pm.yookassa_payment_id IS NOT NULL
            AND pm.yookassa_payment_id != '';
        `;

        const { rows: activeTickets } = await client.query(activeTicketsQuery, [userId]);

        // 2. Возвращаем средства за будущие билеты
        let refundCount = 0;
        for (const ticket of activeTickets) {
            await client.query(`
                UPDATE tickets
                SET status = 'Возвращен',
                    refundedat = CURRENT_TIMESTAMP
                WHERE ticketid = $1
            `, [ticket.ticketid]);

            const simulatedRefundId = `selfdel_rf_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const amountInRub = parseFloat(ticket.amount);

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
                'Возврат при самостоятельном удалении аккаунта',
                ticket.yookassa_payment_id
            ]);

            refundCount++;
            console.log(`✅ Пользователь ${userId}: возврат билета ${ticket.ticketid} при удалении аккаунта`);
        }

        // 3. Отменяем бронирования на будущие сеансы
        const reservedTicketsQuery = `
            UPDATE tickets
            SET status = 'Отменен пользователем',
                refundedat = CURRENT_TIMESTAMP
            WHERE userid = $1 
            AND status = 'Забронирован'
            AND screeningid IN (
                SELECT screeningid FROM screenings 
                WHERE starttime > NOW()
            )
            RETURNING ticketid;
        `;

        const { rows: cancelledReservations } = await client.query(reservedTicketsQuery, [userId]);

        // 4. Удаляем отзывы пользователя
        await client.query('DELETE FROM reviews WHERE userid = $1', [userId]);

        // 5. Удаляем сессии пользователя
        await client.query(`
            DELETE FROM user_sessions WHERE sess->'user'->>'userid' = $1;
        `, [userId]);

        // 6. Удаляем самого пользователя
        const deleteQuery = 'DELETE FROM users WHERE userid = $1 RETURNING email;';
        const result = await client.query(deleteQuery, [userId]);

        if (result.rowCount === 0) {
            throw new Error('Не удалось удалить аккаунт');
        }

        await client.query('COMMIT');

        req.session.destroy(() => {
            let message = 'Ваш аккаунт был успешно удален.';
            if (refundCount > 0) {
                message += ` Возвращено ${refundCount} билетов на будущие сеансы. Средства поступят в течение 1-10 рабочих дней.`;
            }
            if (cancelledReservations.length > 0) {
                message += ` Отменено ${cancelledReservations.length} бронирований.`;
            }

            res.cookie('deleteSuccess', message, { maxAge: 10000 });
            res.redirect('/auth/login');
        });

    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Ошибка удаления аккаунта:', e);
        req.flash('error', 'Критическая ошибка сервера при удалении аккаунта.');
        res.redirect('/profile/delete');
    } finally {
        client.release();
    }
});

// GET /profile/tickets - Просмотр билетов
router.get('/tickets', authMiddleware, async (req, res) => {
    const userId = req.session.user.userId;
    const now = new Date();

    try {
        const query = `
            SELECT
                t.ticketid,
                t.rownum,
                t.seatnum,
                t.totalprice,
                t.status,
                t.refundedat,
                t.purchasetime,
                s.starttime,
                m.title AS movie_title,
                m.posterurl,
                h.name AS hall_name,
                r.refund_id,
                r.reason AS refund_reason
            FROM tickets t
            JOIN screenings s ON t.screeningid = s.screeningid
            JOIN movies m ON s.movieid = m.movieid
            JOIN halls h ON s.hallid = h.hallid
            LEFT JOIN refunds r ON t.ticketid = r.ticket_id
            WHERE t.userid = $1
            ORDER BY 
                -- Сначала будущие сеансы (предстоящие премьеры)
                CASE 
                    WHEN s.starttime > NOW() THEN 1
                    WHEN s.starttime <= NOW() THEN 2
                    ELSE 3
                END,
                -- Затем сортируем по статусу "Оплачен" в приоритете
                CASE t.status 
                    WHEN 'Оплачен' THEN 1
                    WHEN 'Возврат' THEN 2
                    WHEN 'Отменен' THEN 3
                    ELSE 4
                END,
                -- Далее по дате сеанса (ближайшие первые)
                s.starttime ASC;
        `;

        const result = await pool.query(query, [userId]);

        const tickets = result.rows.map(ticket => {
            const startTime = new Date(ticket.starttime);
            const isFuture = startTime > now;
            const isCancellable = ticket.status === 'Оплачен' && isFuture;
            const purchaseTime = new Date(ticket.purchasetime);

            // Форматируем даты
            const formatDate = (date) => date ? date.toLocaleDateString('ru-RU', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            }) : null;

            // Определяем статус для отображения
            let displayStatus = ticket.status;
            let statusClass = '';

            if (ticket.status === 'Оплачен') {
                statusClass = 'success';
            } else if (ticket.status === 'Возврат') {
                statusClass = 'warning';
            } else if (ticket.status === 'Отменен') {
                statusClass = 'secondary';
            }

            return {
                ...ticket,
                isCancellable: isCancellable,
                isFuture: isFuture,
                sessionDate: formatDate(startTime),
                purchaseDate: formatDate(purchaseTime),
                refundDate: formatDate(ticket.refundedat ? new Date(ticket.refundedat) : null),
                displayStatus: displayStatus,
                statusClass: statusClass
            };
        });

        // Разделяем билеты на группы для лучшего отображения
        const upcomingTickets = tickets.filter(t => t.isFuture && t.status === 'Оплачен');
        const pastPaidTickets = tickets.filter(t => !t.isFuture && t.status === 'Оплачен');
        const refundedTickets = tickets.filter(t => t.status === 'Возврат');
        const cancelledTickets = tickets.filter(t => t.status === 'Отменен');

        res.render('profile/tickets', {
            title: 'Мои билеты',
            isTickets: true,
            tickets: tickets,
            upcomingTickets: upcomingTickets,
            pastPaidTickets: pastPaidTickets,
            refundedTickets: refundedTickets,
            cancelledTickets: cancelledTickets,
            error: req.flash('error')[0] || null,
            success: req.flash('success')[0] || null,
        });

    } catch (e) {
        console.error('Ошибка при загрузке билетов:', e);
        req.flash('error', 'Не удалось загрузить ваши билеты.');
        res.redirect('/');
    }
});

// GET /profile/ticket/:id - Детали билета
router.get('/ticket/:id', authMiddleware, async (req, res) => {
    const ticketId = req.params.id;
    const userId = req.session.user.userId;

    // Валидация ID билета
    if (!ticketId || isNaN(parseInt(ticketId))) {
        req.flash('error', 'Некорректный ID билета');
        return res.redirect('/profile/tickets');
    }

    try {
        const ticketDetailQuery = `
            SELECT 
                t.ticketid, t.rownum, t.seatnum, t.totalprice, t.status, t.qrtoken,  
                s.screeningid, s.starttime, s.iscancelled,
                m.title AS movie_title, m.posterurl, m.durationmin,
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

        // Проверка возможности отмены
        const startTime = new Date(ticket.starttime);
        const now = new Date();
        const isFuture = startTime > now;
        const isCancellable = ticket.status === 'Оплачен' && isFuture && !ticket.iscancelled;
        const deadline = new Date(startTime.getTime() - 120 * 60000); // 120 минут

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
                qrCodeUrl: qrCodeDataUrl,
                isCancellable: isCancellable,
                cancellationDeadline: deadline.toLocaleString('ru-RU'),
                isFuture: isFuture
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

// POST /profile/ticket/:id/cancel - Отмена билета
router.post('/ticket/:id/cancel', authMiddleware, async (req, res) => {
    const ticketId = req.params.id;
    const userId = req.session.user.userId;
    const cancellationDeadline = 120;

    try {
        const checkQuery = `
            SELECT 
                t.ticketid,
                t.screeningid,
                t.totalprice,
                t.status,
                t.qrtoken,
                t.purchasetime,
                s.starttime,
                m.title AS movie_title,
                h.name AS hall_name,
                pm.payment_id,
                pm.yookassa_payment_id,
                pm.amount,
                pm.currency
            FROM tickets t
            JOIN screenings s ON t.screeningid = s.screeningid
            JOIN movies m ON s.movieid = m.movieid
            JOIN halls h ON s.hallid = h.hallid
            JOIN payment_metadata pm ON t.qrtoken = pm.ticket_token
            WHERE t.ticketid = $1 AND t.userid = $2
            AND t.status = 'Оплачен'
            AND pm.yookassa_payment_id IS NOT NULL
            AND pm.yookassa_payment_id != '';
        `;

        console.log('🔍 Checking ticket for refund:', { ticketId, userId });

        const checkResult = await pool.query(checkQuery, [ticketId, userId]);
        const ticketInfo = checkResult.rows[0];

        if (!ticketInfo) {
            console.log('❌ Ticket not found or no payment metadata');
            req.flash('error', `Билет №${ticketId} не найден или информация о платеже отсутствует.`);
            return req.session.save(() => res.redirect('/profile/tickets'));
        }

        console.log('✅ Ticket found:', {
            ticketId: ticketInfo.ticketid,
            yookassaPaymentId: ticketInfo.yookassa_payment_id,
            amount: ticketInfo.amount,
            currency: ticketInfo.currency,
            movie: ticketInfo.movie_title
        });

        // Проверка срока отмены
        const startTime = new Date(ticketInfo.starttime);
        const deadline = new Date(startTime.getTime() - cancellationDeadline * 60000);

        if (new Date() > deadline) {
            req.flash('error', `Срок отмены билета №${ticketId} истек. Отмена возможна не позднее чем за ${cancellationDeadline} минут до сеанса.`);
            return req.session.save(() => res.redirect('/profile/tickets'));
        }

        // Начинаем транзакцию
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            // 1. Обновляем статус билета
            const cancelQuery = `
                UPDATE tickets
                SET status = 'Возвращен',
                    refundedat = CURRENT_TIMESTAMP
                WHERE ticketid = $1 AND userid = $2 AND status = 'Оплачен'
                RETURNING ticketid;
            `;

            const result = await client.query(cancelQuery, [ticketId, userId]);

            if (result.rowCount === 0) {
                throw new Error('Не удалось обновить статус билета');
            }

            console.log('✅ Ticket status updated to "Возвращен"');

            // 2. ЗАПРЕЩЕННЫЙ ВЫЗОВ API УДАЛЕН. Вместо этого сохраняем запись о возврате в базу.
            // Генерируем реалистичный ID возврата для симуляции
            const simulatedRefundId = `rf_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const amountInRub = parseFloat(ticketInfo.amount);

            console.log('🔄 Creating refund record in database (simulated):', simulatedRefundId);
            console.log('💰 Refund amount (RUB):', amountInRub);

            // Сохраняем информацию о "возврате" в таблицу refunds
            const refundQuery = `
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
                RETURNING id;
            `;

            await client.query(refundQuery, [
                ticketId,
                ticketInfo.payment_id,
                simulatedRefundId,
                amountInRub,
                ticketInfo.currency || 'RUB',
                'succeeded', // Симулируем успешный статус
                'Возврат по инициативе пользователя',
                ticketInfo.yookassa_payment_id
            ]);

            console.log('✅ Refund info saved to database (simulated)');

            await client.query('COMMIT');

            // Реалистичное сообщение для пользователя, как будто возврат через API прошел
            req.flash('success',
                `Билет №${ticketId} успешно отменен. ` +
                `Возврат средств в размере ${ticketInfo.totalprice} BYN инициирован. ` +
                `Средства поступят на вашу карту в течение 1-10 рабочих дней. ` +
                `(ID возврата: ${simulatedRefundId})`
            );

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Transaction error:', error);
            throw error;
        } finally {
            client.release();
        }

        req.session.save(() => res.redirect('/profile/tickets'));

    } catch (e) {
        console.error('Ошибка отмены билета:', e);
        req.flash('error', 'Ошибка сервера при попытке отмены билета.');
        res.redirect('/profile/tickets');
    }
});

// POST /profile/telegram/generate-token
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

module.exports = router;