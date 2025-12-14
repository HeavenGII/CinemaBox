const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const crypto = require('crypto');

const YooKassa = require('yookassa');

const router = Router();

// ПРОВЕРКА ПЕРЕМЕННЫХ ОКРУЖЕНИЯ С БОЛЕЕ ИНФОРМАТИВНЫМИ СООБЩЕНИЯМИ
if (!process.env.YOO_KASSA_SECRET_KEY) {
    console.error("⛔️ КРИТИЧЕСКАЯ ОШИБКА: Переменная окружения YOO_KASSA_SECRET_KEY не установлена!");
    console.error("Добавьте в .env: YOO_KASSA_SECRET_KEY=ваш_секретный_ключ");
}

if (!process.env.YOO_KASSA_SHOP_ID) {
    console.error("⛔️ КРИТИЧЕСКАЯ ОШИБКА: Переменная окружения YOO_KASSA_SHOP_ID не установлена!");
    console.error("Добавьте в .env: YOO_KASSA_SHOP_ID=ваш_shop_id");
}

// Инициализация YooKassa только если переменные существуют
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
    'BYN': 28.00 // Исправленный курс: 1 BYN = 28.00 RUB (было 23.61)
};

async function createTicketRecords(ticketData, userId, paymentId, yookassaPaymentId) {
    // --- ЛОГИРОВАНИЕ ---
    console.log(`[DB Action] Попытка создания билетов. Получен userId: ${userId || 'NULL'}`);
    console.log(`[DB Action] Payment ID: ${paymentId}, YooKassa Payment ID: ${yookassaPaymentId}`);
    // ----------------------------

    if (!pool || typeof pool.query !== 'function') {
        console.error("[DB Action] КРИТИЧЕСКАЯ ОШИБКА: Объект 'pool' БД не определен.");
        return false;
    }
    if (!ticketData || ticketData.length === 0) {
        console.warn("[DB Action] Некорректный или пустой массив данных о билетах для создания.");
        return false;
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
            } else if (screeningId !== currentScreeningId) {
                throw new Error("Обнаружены билеты для разных сеансов в одном заказе.");
            }

            if (isNaN(rownum) || isNaN(seatnum)) {
                throw new Error(`Некорректный формат места: ${item.seatKey}`);
            }

            const finalPrice = parseFloat(item.price);
            if (isNaN(finalPrice) || finalPrice <= 0) {
                throw new Error(`Некорректная цена: ${item.price}`);
            }

            bookedSeatChecks.push(`(rownum = ${rownum} AND seatnum = ${seatnum})`);
            const qrToken = crypto.randomBytes(16).toString('hex');

            insertData.push({ rownum, seatnum, finalPrice, qrToken });
        }

        const checkQuery = `
            SELECT rownum, seatnum FROM tickets
            WHERE screeningid = $1 AND status = 'Оплачен'
            AND (${bookedSeatChecks.join(' OR ')});
        `;
        const { rows: occupiedSeats } = await client.query(checkQuery, [screeningId]);

        if (occupiedSeats.length > 0) {
            console.error("[DB Action] КОНФЛИКТ: Места уже заняты:", occupiedSeats);
            await client.query('ROLLBACK');
            return false;
        }

        const rowsToInsert = insertData.map(d => d.rownum);
        const seatsToInsert = insertData.map(d => d.seatnum);
        const pricesToInsert = insertData.map(d => d.finalPrice.toFixed(2));
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

        // Сохраняем связь между платежом и билетами
        for (let i = 0; i < result.rows.length; i++) {
            const ticketId = result.rows[i].ticketid;
            const qrToken = result.rows[i].qrtoken;
            const priceInRub = (parseFloat(pricesToInsert[i]) * MOCK_EXCHANGE_RATES['BYN']).toFixed(2);

            const paymentMetaQuery = `
                INSERT INTO payment_metadata (
                    payment_id,
                    yookassa_payment_id,
                    order_id,
                    user_id,
                    amount,
                    currency,
                    status,
                    ticket_token
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
            `;

            await client.query(paymentMetaQuery, [
                paymentId,
                yookassaPaymentId,
                `order_${Date.now()}_${ticketId}`,
                userId,
                priceInRub, // Исправлено: умножаем на курс
                'RUB',
                'succeeded',
                qrToken
            ]);
        }

        await client.query('COMMIT');
        console.log(`[DB Action] Успешно создано ${result.rowCount} новых билетов.`);
        return true;

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("[DB Action] Ошибка при создании записей билетов в БД:", error);
        return false;
    } finally {
        client.release();
    }
}

router.post('/place-order', authMiddleware, async (req, res) => {
    // Проверяем, инициализирован ли YooKassa
    if (!yookassa) {
        console.error("❌ YooKassa не инициализирован! Проверьте переменные окружения.");
        return res.status(500).json({
            error: 'Платежная система временно недоступна. Пожалуйста, попробуйте позже.'
        });
    }

    const { totalAmount, orderDescription, ticketIds } = req.body;
    const rawUserId = req.session.user.userId;
    const currentUserId = rawUserId ? String(rawUserId) : null;

    if (!currentUserId || typeof currentUserId !== 'string' || currentUserId.trim() === '') {
        console.warn(`⚠️ [Order] userId: ${currentUserId} - Некорректный ID пользователя в сессии. Заказ будет помечен как анонимный.`);
    }

    console.log("--- Получено в /payment/place-order ---");
    console.log("Total Amount:", totalAmount, "BYN");
    console.log("User ID:", currentUserId || 'Anonymous');
    console.log("Ticket Count:", ticketIds ? ticketIds.length : 0);
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
                ticketIds: JSON.stringify(ticketIds)
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
        console.error("Детали ошибки:", error);

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

    if (!payment || !payment.metadata || !payment.metadata.ticketIds) {
        console.error('[ЮKassa Webhook] Пропущено: Отсутствуют данные платежа или ticketIds.');
        return res.status(200).send({ message: 'Отсутствуют необходимые метаданные' });
    }

    let ticketIds;
    try {
        ticketIds = JSON.parse(payment.metadata.ticketIds);
        if (!Array.isArray(ticketIds) || ticketIds.length === 0) {
            throw new Error("ticketIds is not a valid non-empty array.");
        }
    } catch (e) {
        console.error('[ЮKassa Webhook] Ошибка парсинга ticketIds:', e);
        return res.status(200).send({ message: 'Ошибка парсинга ticketIds, действие пропущено' });
    }

    const userId = payment.metadata.userId || null;

    try {
        switch (event.event) {
            case 'payment.succeeded': {
                console.log(`✅ [ЮKassa Success] Платеж ID: ${payment.id} успешен. Сумма: ${payment.amount.value} ${payment.amount.currency}.`);
                console.log(`   Метод оплаты: ${payment.payment_method?.type || 'не указан'}`);
                console.log(`   Заказ: ${payment.metadata.orderId}`);
                console.log(`   Пользователь: ${userId || 'аноним'}`);

                const success = await createTicketRecords(
                    ticketIds,
                    userId,
                    payment.metadata.orderId || payment.id,
                    payment.id
                );

                if (!success) {
                    console.error("❌ [ЮKassa Webhook] Ошибка записи в БД. Требуется повтор.");
                    return res.status(500).send('Database write error');
                }

                console.log("✅ [ЮKassa Success] Билеты успешно записаны.");
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

            case 'payment.canceled': {
                console.log(`❌ [ЮKassa Canceled] Платеж ID: ${payment.id} отменен.`);
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
        console.error("Stack trace:", error.stack);
        res.status(500).send('Internal Server Error');
    }
});

module.exports = router;