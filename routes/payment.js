const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const crypto = require('crypto');

const YooKassa = require('yookassa');

const router = Router();

if (!process.env.YOO_KASSA_SECRET_KEY) {
    console.error("⛔️ КРИТИЧЕСКАЯ ОШИБКА: Переменная окружения YOO_KASSA_SECRET_KEY не установлена!");
    console.error("Добавьте в .env: YOO_KASSA_SECRET_KEY=ваш_секретный_ключ");
}

if (!process.env.YOO_KASSA_SHOP_ID) {
    console.error("⛔️ КРИТИЧЕСКАЯ ОШИБКА: Переменная окружения YOO_KASSA_SHOP_ID не установлена!");
    console.error("Добавьте в .env: YOO_KASSA_SHOP_ID=ваш_shop_id");
}

let yookassa;
if (process.env.YOO_KASSA_SECRET_KEY && process.env.YOO_KASSA_SHOP_ID) {
    try {
        yookassa = new YooKassa({
            shopId: process.env.YOO_KASSA_SHOP_ID,
            secretKey: process.env.YOO_KASSA_SECRET_KEY
        });
        console.log(`✅ YooKassa успешно инициализирован. Shop ID: ${process.env.YOO_KASSA_SHOP_ID.substring(0, 5)}...`);
    } catch (error) {
        console.error("❌ Ошибка инициализации YooKassa:", error.message);
    }
} else {
    console.warn("⚠️ YooKassa не инициализирован из-за отсутствия переменных окружения");
}

const MOCK_EXCHANGE_RATES = {
    'BYN': 28.00
};

// Функция для обновления временных бронирований после успешной оплаты
async function updateTempReservationToPaid(ticketIds, userId, paymentData) {
    console.log(`[Update Reservation] Обновление временных бронирований на оплаченные`);
    console.log(`[Update Reservation] Payment ID: ${paymentData.paymentId}, Order ID: ${paymentData.orderId}`);
    console.log(`[Update Reservation] Ticket IDs:`, JSON.stringify(ticketIds));

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const screeningId = parseInt(ticketIds[0].screeningId, 10);

        // Получаем базовую цену фильма
        const priceQuery = `
            SELECT m.price 
            FROM screenings s
            JOIN movies m ON s.movieid = m.movieid
            WHERE s.screeningid = $1
        `;
        const priceResult = await client.query(priceQuery, [screeningId]);
        const basePrice = priceResult.rows[0]?.price || 0;
        console.log(`[Update Reservation] Базовая цена: ${basePrice} BYN`);

        // Проверяем, не существует ли уже запись о платеже
        const existingPaymentCheck = await client.query(`
            SELECT id, created_at FROM payment_metadata WHERE payment_id = $1
        `, [paymentData.orderId]);

        if (existingPaymentCheck.rows.length > 0) {
            console.log(`[Update Reservation] Платеж ${paymentData.orderId} уже обработан в ${existingPaymentCheck.rows[0].created_at}`);

            // Но все равно проверяем и обновляем статусы билетов
            for (const ticket of ticketIds) {
                const [row, seat] = ticket.seatKey.split('-').map(Number);

                // Проверяем статус этого билета
                const ticketCheck = await client.query(`
                    SELECT status FROM tickets 
                    WHERE screeningid = $1 
                    AND userid = $2 
                    AND rownum = $3 
                    AND seatnum = $4
                `, [screeningId, userId, row, seat]);

                if (ticketCheck.rows.length > 0 && ticketCheck.rows[0].status === 'Забронирован') {
                    console.log(`[Update Reservation] Билет ${ticket.seatKey} все еще в статусе "Забронирован", обновляю`);

                    const finalPrice = (basePrice * MOCK_EXCHANGE_RATES['BYN']).toFixed(2);
                    await client.query(`
                        UPDATE tickets 
                        SET status = 'Оплачен',
                            totalprice = $1,
                            reservationexpiresat = NULL
                        WHERE screeningid = $2 
                        AND userid = $3 
                        AND rownum = $4 
                        AND seatnum = $5
                    `, [finalPrice, screeningId, userId, row, seat]);
                }
            }

            await client.query('COMMIT');
            return { success: true, alreadyProcessed: true };
        }

        // Создаем новую запись о платеже
        console.log(`[Update Reservation] Создание новой записи о платеже`);

        // Обновляем каждый билет
        let updatedCount = 0;
        for (const ticket of ticketIds) {
            const [row, seat] = ticket.seatKey.split('-').map(Number);
            const finalPrice = (basePrice * MOCK_EXCHANGE_RATES['BYN']).toFixed(2);

            // Находим и обновляем временное бронирование
            const updateResult = await client.query(`
                UPDATE tickets 
                SET status = 'Оплачен',
                    totalprice = $1,
                    reservationexpiresat = NULL
                WHERE screeningid = $2 
                AND userid = $3 
                AND rownum = $4 
                AND seatnum = $5 
                AND status = 'Забронирован'
                RETURNING ticketid, qrtoken
            `, [finalPrice, screeningId, userId, row, seat]);

            if (updateResult.rows.length > 0) {
                const ticketId = updateResult.rows[0].ticketid;
                const qrToken = updateResult.rows[0].qrtoken;
                updatedCount++;

                console.log(`[Update Reservation] Обновлен билет ${ticketId} для места ${ticket.seatKey}`);

                // Записываем метаданные платежа (только для первого билета)
                if (updatedCount === 1) {
                    await client.query(`
                        INSERT INTO payment_metadata (
                            payment_id,
                            yookassa_payment_id,
                            order_id,
                            user_id,
                            amount,
                            currency,
                            status,
                            ticket_token
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        ON CONFLICT (payment_id) DO NOTHING
                    `, [
                        paymentData.orderId,
                        paymentData.paymentId,
                        `order_${Date.now()}_${ticketId}`,
                        userId,
                        finalPrice,
                        'RUB',
                        'succeeded',
                        qrToken
                    ]);
                }
            } else {
                console.warn(`[Update Reservation] Не удалось найти бронирование для места ${ticket.seatKey}`);
            }
        }

        await client.query('COMMIT');
        console.log(`[Update Reservation] Успешно обновлено ${updatedCount} из ${ticketIds.length} бронирований`);

        return { success: true, updatedCount };

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("[Update Reservation] Критическая ошибка:", error);
        return { success: false, error: error.message };
    } finally {
        client.release();
    }
}

// Старая функция для обратной совместимости
async function createTicketRecords(ticketData, userId, paymentId, yookassaPaymentId) {
    console.log(`[DB Action] Создание билетов (старый метод)`);

    // Проверяем, не обработан ли уже этот платеж
    try {
        const existingCheck = await pool.query(`
            SELECT 1 FROM payment_metadata WHERE payment_id = $1
        `, [paymentId]);

        if (existingCheck.rows.length > 0) {
            console.log(`[DB Action] Платеж ${paymentId} уже обработан, пропускаем`);
            return true;
        }
    } catch (error) {
        console.log(`[DB Action] Ошибка при проверке существующего платежа:`, error.message);
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const insertData = [];
        const bookedSeatChecks = [];
        let screeningId;

        for (const item of ticketData) {
            const [rownum, seatnum] = item.seatKey.split('-').map(Number);

            const currentScreeningId = parseInt(item.screeningId, 10);
            if (isNaN(currentScreeningId)) {
                throw new Error(`Некорректный ID сеанса: ${item.screeningId}`);
            }
            if (!screeningId) {
                screeningId = currentScreeningId;
            }

            bookedSeatChecks.push(`(rownum = ${rownum} AND seatnum = ${seatnum})`);
            const qrToken = crypto.randomBytes(16).toString('hex');

            insertData.push({ rownum, seatnum, qrToken });
        }

        // Проверяем, не заняты ли места (включая временные бронирования)
        const checkQuery = `
            SELECT rownum, seatnum FROM tickets
            WHERE screeningid = $1 
            AND (
                status = 'Оплачен' 
                OR status = 'Бронь'
                OR (status = 'Забронирован' AND reservationexpiresat > NOW())
            )
            AND (${bookedSeatChecks.join(' OR ')});
        `;
        const { rows: occupiedSeats } = await client.query(checkQuery, [screeningId]);

        if (occupiedSeats.length > 0) {
            console.error("[DB Action] КОНФЛИКТ: Места уже заняты:", occupiedSeats);
            await client.query('ROLLBACK');
            return false;
        }

        // Получаем цену фильма
        const priceQuery = `
            SELECT m.price 
            FROM screenings s
            JOIN movies m ON s.movieid = m.movieid
            WHERE s.screeningid = $1
        `;
        const priceResult = await client.query(priceQuery, [screeningId]);
        const basePrice = priceResult.rows[0]?.price || 0;
        const finalPrice = (basePrice * MOCK_EXCHANGE_RATES['BYN']).toFixed(2);

        // Создаем билеты
        const rowsToInsert = insertData.map(d => d.rownum);
        const seatsToInsert = insertData.map(d => d.seatnum);
        const pricesToInsert = insertData.map(() => finalPrice);
        const tokensToInsert = insertData.map(d => d.qrToken);

        const insertQuery = `
            INSERT INTO tickets (screeningid, userid, rownum, seatnum, totalprice, status, qrtoken) 
            SELECT 
                $1, 
                $2, 
                unnest($3::int[]), 
                unnest($4::int[]), 
                unnest($5::numeric[]), 
                'Оплачен',
                unnest($6::text[])
            RETURNING ticketid, qrtoken;
        `;

        const result = await client.query(insertQuery, [
            screeningId,
            userId,
            rowsToInsert,
            seatsToInsert,
            pricesToInsert,
            tokensToInsert
        ]);

        // Записываем метаданные платежа
        for (let i = 0; i < result.rows.length; i++) {
            const ticketId = result.rows[i].ticketid;
            const qrToken = result.rows[i].qrtoken;

            await client.query(`
                INSERT INTO payment_metadata (
                    payment_id,
                    yookassa_payment_id,
                    order_id,
                    user_id,
                    amount,
                    currency,
                    status,
                    ticket_token
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (payment_id) DO NOTHING
            `, [
                paymentId,
                yookassaPaymentId,
                `order_${Date.now()}_${ticketId}`,
                userId,
                finalPrice,
                'RUB',
                'succeeded',
                qrToken
            ]);
        }

        await client.query('COMMIT');
        console.log(`[DB Action] Успешно создано ${result.rowCount} билетов.`);
        return true;

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("[DB Action] Ошибка:", error);
        return false;
    } finally {
        client.release();
    }
}

async function checkAndFixTicketStatus(userId) {

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Находим билеты, которые оплачены (по payment_metadata), но имеют статус "Забронирован"
        const problemTickets = await client.query(`
            SELECT 
                t.ticketid,
                t.qrtoken,
                t.status as ticket_status,
                pm.payment_id,
                pm.status as payment_status,
                pm.amount as payment_amount
            FROM tickets t
            JOIN payment_metadata pm ON t.qrtoken = pm.ticket_token
            WHERE t.userid = $1
            AND t.status = 'Забронирован'
            AND pm.status = 'succeeded'
            AND pm.user_id = $1
        `, [userId]);

        console.log(`[Status Fix] Найдено проблемных билетов: ${problemTickets.rows.length}`);

        if (problemTickets.rows.length > 0) {
            for (const ticket of problemTickets.rows) {
                console.log(`[Status Fix] Исправляю билет ${ticket.ticketid}, платеж ${ticket.payment_id}`);

                // Обновляем статус на "Оплачен"
                await client.query(`
                    UPDATE tickets 
                    SET status = 'Оплачен',
                        totalprice = $1 / 28.00, -- конвертируем из RUB в BYN
                        reservationexpiresat = NULL
                    WHERE ticketid = $2
                `, [ticket.payment_amount, ticket.ticketid]);
            }

            await client.query('COMMIT');
            console.log(`[Status Fix] Успешно исправлено ${problemTickets.rows.length} билетов`);
            return { success: true, fixedCount: problemTickets.rows.length };
        } else {
            await client.query('ROLLBACK');
            console.log(`[Status Fix] Проблемных билетов не найдено`);
            return { success: true, fixedCount: 0 };
        }

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("[Status Fix] Ошибка:", error);
        return { success: false, error: error.message };
    } finally {
        client.release();
    }
}

// Маршрут для отмены бронирования
router.post('/cancel-reservation', authMiddleware, async (req, res) => {
    const userId = req.session.user.userId;

    try {
        const result = await pool.query(`
            DELETE FROM tickets 
            WHERE userid = $1
            AND status = 'Забронирован'
            AND reservationexpiresat > NOW()
            RETURNING ticketid;
        `, [userId]);

        return res.json({
            success: true,
            message: `Отменено ${result.rowCount} бронирований`,
            canceledCount: result.rowCount
        });

    } catch (error) {
        console.error("[Cancel Reservation] Ошибка:", error);
        return res.status(500).json({ error: 'Ошибка при отмене бронирования' });
    }
});

router.post('/place-order', authMiddleware, async (req, res) => {
    if (!yookassa) {
        console.error("❌ YooKassa не инициализирован! Проверьте переменные окружения.");
        return res.status(500).json({
            error: 'Платежная система временно недоступна. Пожалуйста, попробуйте позже.'
        });
    }

    const { totalAmount, orderDescription, ticketIds, reservationId } = req.body;
    const rawUserId = req.session.user.userId;
    const currentUserId = rawUserId ? String(rawUserId) : null;

    console.log("--- Получено в /payment/place-order ---");
    console.log("Total Amount:", totalAmount, "BYN");
    console.log("User ID:", currentUserId || 'Anonymous');
    console.log("Ticket Count:", ticketIds ? ticketIds.length : 0);
    console.log("Reservation ID:", reservationId || 'Нет');
    console.log("---------------------------------------");

    if (!totalAmount || !ticketIds || ticketIds.length === 0) {
        return res.status(400).json({ error: 'Некорректные данные для оплаты.' });
    }

    const SOURCE_CURRENCY = 'BYN';
    const TARGET_CURRENCY = 'RUB';
    const EXCHANGE_RATE = MOCK_EXCHANGE_RATES[SOURCE_CURRENCY];

    let finalAmountRub;
    const amountFloat = Number(totalAmount);

    try {
        if (!EXCHANGE_RATE) {
            throw new Error(`Обменный курс для ${SOURCE_CURRENCY} не найден.`);
        }
        finalAmountRub = amountFloat * EXCHANGE_RATE;
        console.log(`[Конвертация] ${amountFloat} BYN -> ${finalAmountRub.toFixed(2)} RUB (курс: ${EXCHANGE_RATE})`);

    } catch (e) {
        console.error(`[Conversion Error] Ошибка конвертации: ${e.message}`);
        return res.status(500).json({ error: `Ошибка конвертации валюты.`, details: e.message });
    }

    const orderId = uuidv4();
    const amountValue = finalAmountRub.toFixed(2);

    const metadataUserId = (currentUserId && currentUserId.trim() !== '') ? currentUserId : null;

    try {
        const payment = await yookassa.createPayment({
            amount: {
                value: amountValue,
                currency: TARGET_CURRENCY
            },
            confirmation: {
                type: 'redirect',
                return_url: process.env.YOO_KASSA_SUCCESS_URL || 'http://localhost:3000/profile/tickets?status=success'
            },
            capture: true,
            description: orderDescription || `Оплата билетов (Заказ ${orderId})`,
            metadata: {
                orderId: orderId,
                userId: metadataUserId,
                sourceCurrency: SOURCE_CURRENCY,
                sourceAmount: amountFloat.toFixed(2),
                convertedAmount: amountValue,
                ticketIds: JSON.stringify(ticketIds),
                reservationId: reservationId || null,
                hasTempReservation: !!reservationId
            }
        }, orderId);

        if (payment && payment.confirmation && payment.confirmation.confirmation_url) {
            console.log(`✅ [ЮKassa] Создан платеж ID: ${payment.id}. Сумма: ${amountValue} RUB.`);
            console.log(`🔗 URL для оплаты: ${payment.confirmation.confirmation_url}`);
            return res.status(200).json({
                url: payment.confirmation.confirmation_url,
                paymentId: payment.id
            });
        } else {
            console.error('❌ [ЮKassa] Платеж создан, но нет URL для перенаправления:', payment);
            return res.status(500).json({ error: 'Ошибка при получении URL для оплаты.' });
        }

    } catch (error) {
        console.error("❌ Критическая ошибка при создании платежа ЮKassa:", error.message);

        return res.status(500).json({
            error: 'Не удалось создать платеж.',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

router.post('/webhook', async (req, res) => {
    let event;
    try {
        event = JSON.parse(req.body.toString());
    } catch (e) {
        console.error("[ЮKassa Webhook] Ошибка парсинга тела запроса:", e);
        return res.status(400).send('Invalid JSON format');
    }

    console.log(`[ЮKassa Webhook] Получено событие: ${event.event}`);

    const payment = event.object;

    if (!payment || !payment.metadata) {
        console.error('[ЮKassa Webhook] Пропущено: Отсутствуют метаданные платежа.');
        return res.status(200).send({ message: 'Отсутствуют метаданные' });
    }

    let ticketIds;
    try {
        ticketIds = payment.metadata.ticketIds ? JSON.parse(payment.metadata.ticketIds) : [];
    } catch (e) {
        console.error('[ЮKassa Webhook] Ошибка парсинга ticketIds:', e);
        ticketIds = [];
    }

    const userId = payment.metadata.userId || null;
    const hasTempReservation = payment.metadata.hasTempReservation === 'true' ||
        payment.metadata.hasTempReservation === true;

    // Проверяем, не обработан ли уже этот платеж
    try {
        const existingPaymentCheck = await pool.query(`
            SELECT 1 FROM payment_metadata WHERE payment_id = $1
        `, [payment.metadata.orderId]);

        if (existingPaymentCheck.rows.length > 0) {
            console.log(`[ЮKassa Webhook] Платеж ${payment.metadata.orderId} уже обработан, пропускаем`);
            return res.status(200).send({ message: 'Платеж уже обработан' });
        }
    } catch (error) {
        console.error('[ЮKassa Webhook] Ошибка при проверке существующего платежа:', error);
    }

    try {
        switch (event.event) {
            case 'payment.succeeded': {
                console.log(`✅ [ЮKassa Success] Платеж ID: ${payment.id} успешен. Сумма: ${payment.amount.value} ${payment.amount.currency}.`);
                console.log(`   Метод оплаты: ${payment.payment_method?.type || 'не указан'}`);
                console.log(`   Заказ: ${payment.metadata.orderId}`);
                console.log(`   Пользователь: ${userId || 'аноним'}`);
                console.log(`   Есть временное бронирование: ${hasTempReservation}`);

                let success;

                if (hasTempReservation && userId) {
                    // Обновляем временное бронирование
                    success = await updateTempReservationToPaid(
                        ticketIds,
                        userId,
                        {
                            orderId: payment.metadata.orderId,
                            paymentId: payment.id
                        }
                    );
                } else {
                    // Старый способ создания билетов
                    success = await createTicketRecords(
                        ticketIds,
                        userId,
                        payment.metadata.orderId || payment.id,
                        payment.id
                    );
                }

                if (!success && success !== false) {
                    console.error("❌ [ЮKassa Webhook] Ошибка записи в БД.");
                    return res.status(500).send('Database write error');
                }

                console.log("✅ [ЮKassa Success] Билеты успешно обработаны.");
                break;
            }

            case 'payment.canceled': {
                console.log(`❌ [ЮKassa Canceled] Платеж ID: ${payment.id} отменен.`);

                // Если есть userId, удаляем его временные бронирования
                if (userId) {
                    try {
                        await pool.query(`
                            DELETE FROM tickets 
                            WHERE userid = $1
                            AND status = 'Забронирован'
                            AND reservationexpiresat > NOW()
                        `, [userId]);
                        console.log(`[ЮKassa Canceled] Удалены временные бронирования пользователя ${userId}`);
                    } catch (cleanupError) {
                        console.error("[ЮKassa Canceled] Ошибка при очистке бронирований:", cleanupError);
                    }
                }
                break;
            }

            case 'refund.succeeded': {
                console.log(`💰 [ЮKassa Refund] Возврат ID: ${payment.id} успешен.`);

                const updateRefundQuery = `
                    UPDATE refunds 
                    SET status = 'succeeded',
                        processed_at = CURRENT_TIMESTAMP
                    WHERE refund_id = $1
                    RETURNING ticket_id;
                `;

                const result = await pool.query(updateRefundQuery, [payment.id]);

                if (result.rows.length > 0) {
                    console.log(`✅ Статус возврата обновлен для билета ${result.rows[0].ticket_id}`);
                }
                break;
            }

            case 'payment.waiting_for_capture': {
                console.log(`⏳ [ЮKassa] Платеж ID: ${payment.id} ожидает захвата.`);
                break;
            }

            default:
                console.log(`ℹ️ [ЮKassa Webhook] Тип события ${event.event} игнорируется.`);
        }

        res.status(200).send({ message: 'Уведомление ЮKassa успешно обработано' });

    } catch (error) {
        console.error("❌ Критическая ошибка при обработке Webhook ЮKassa:", error);
        res.status(500).send('Internal Server Error');
    }
});

router.get('/check-tickets', authMiddleware, async (req, res) => {
    const userId = req.session.user.userId;

    try {
        const result = await checkAndFixTicketStatus(userId);

        if (result.success) {
            return res.json({
                success: true,
                message: `Исправлено ${result.fixedCount} билетов`,
                fixedCount: result.fixedCount
            });
        } else {
            return res.status(500).json({
                success: false,
                error: result.error
            });
        }

    } catch (error) {
        console.error("[Check Tickets] Ошибка:", error);
        return res.status(500).json({ error: 'Ошибка при проверке билетов' });
    }
});

async function quickCheckPaymentStatus(paymentId, userId) {

    const client = await pool.connect();

    try {
        // 1. Проверяем, есть ли уже успешная запись о платеже
        const paymentCheck = await client.query(`
            SELECT status FROM payment_metadata 
            WHERE payment_id = $1 OR yookassa_payment_id = $1
        `, [paymentId]);

        if (paymentCheck.rows.length > 0 && paymentCheck.rows[0].status === 'succeeded') {
            console.log(`[Quick Check] Платеж ${paymentId} уже отмечен как успешный`);

            // 2. Находим и обновляем связанные билеты
            const ticketsResult = await client.query(`
                UPDATE tickets 
                SET status = 'Оплачен',
                    reservationexpiresat = NULL
                WHERE userid = $1
                AND status = 'Забронирован'
                AND qrtoken IN (
                    SELECT ticket_token FROM payment_metadata 
                    WHERE (payment_id = $2 OR yookassa_payment_id = $2)
                    AND status = 'succeeded'
                )
                RETURNING ticketid
            `, [userId, paymentId]);

            console.log(`[Quick Check] Обновлено ${ticketsResult.rows.length} билетов`);
            return { success: true, updated: ticketsResult.rows.length };
        }

        return { success: true, updated: 0 };

    } catch (error) {
        console.error(`[Quick Check] Ошибка:`, error);
        return { success: false, error: error.message };
    } finally {
        client.release();
    }
}

router.get('/quick-check/:paymentId', authMiddleware, async (req, res) => {
    const { paymentId } = req.params;
    const userId = req.session.user.userId;

    try {
        const result = await quickCheckPaymentStatus(paymentId, userId);
        res.json(result);
    } catch (error) {
        console.error('[Quick Check Route] Ошибка:', error);
        res.status(500).json({ success: false, error: 'Ошибка проверки' });
    }
});

module.exports = router;