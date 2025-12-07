const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const crypto = require('crypto');

const YooKassa = require('yookassa');

const router = Router();


if (!process.env.YOO_KASSA_SECRET_KEY || !process.env.YOO_KASSA_SHOP_ID) {
    console.error("⛔️ Ошибка: Переменные окружения YOO_KASSA_SECRET_KEY или YOO_KASSA_SHOP_ID не установлены. Платежи ЮKassa работать не будут!");
}

const yookassa = new YooKassa({
    shopId: process.env.YOO_KASSA_SHOP_ID,
    secretKey: process.env.YOO_KASSA_SECRET_KEY
});


const MOCK_EXCHANGE_RATES = {
    'BYN': 23.61 // 1 BYN = 28.00 RUB
};


async function createTicketRecords(ticketData, userId) {
    // --- ЛОГИРОВАНИЕ ---
    console.log(`[DB Action] Попытка создания билетов. Получен userId: ${userId || 'NULL'}`);
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
            RETURNING ticketid;
        `;

        const result = await client.query(insertQuery, [
            screeningId,
            userId,
            rowsToInsert,
            seatsToInsert,
            pricesToInsert,
            tokensToInsert
        ]);

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

    const { totalAmount, orderDescription, ticketIds } = req.body;
    const rawUserId = req.session.user.userId;
    const currentUserId = rawUserId ? String(rawUserId) : null;

    if (!currentUserId || typeof currentUserId !== 'string' || currentUserId.trim() === '') {
        console.warn(`⚠️ [Order] userId: ${currentUserId} - Некорректный ID пользователя в сессии. Заказ будет помечен как анонимный.`);
    }

    console.log("--- Получено в /payment/place-order ---");
    console.log("Received Total Amount:", totalAmount);
    console.log("User ID from Session:", currentUserId);
    if (ticketIds && ticketIds.length > 0) {
        console.log("Ticket Data Sample (First Item):", ticketIds[0]);
    } else {
        console.log("Ticket Data: Empty or Missing");
    }
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
        console.log(`[Конвертация] ${amountFloat} BYN -> ${finalAmountRub.toFixed(2)} RUB`);

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
                return_url: process.env.YOO_KASSA_SUCCESS_URL
            },
            capture: true,
            description: orderDescription || `Оплата билетов (Заказ ${orderId})`,
            metadata: {
                orderId: orderId,
                userId: metadataUserId,
                sourceCurrency: SOURCE_CURRENCY,
                ticketIds: JSON.stringify(ticketIds)
            }
        }, orderId);

        if (payment && payment.confirmation && payment.confirmation.confirmation_url) {
            console.log(`[ЮKassa] Создан платеж ID: ${payment.id}. Перенаправление.`);
            return res.status(200).json({ url: payment.confirmation.confirmation_url });
        } else {
            console.error('[ЮKassa] Платеж создан, но нет URL для перенаправления:', payment);
            return res.status(500).json({ error: 'Ошибка при получении URL для оплаты.' });
        }

    } catch (error) {
        console.error("Критическая ошибка при создании платежа ЮKassa:", error.message);
        return res.status(500).json({
            error: 'Не удалось создать платеж. Проверьте настройки магазина ЮKassa.',
            details: error.message
        });
    }
});


router.post('/webhook', async (req, res) => {
    let event;
    try {
        // Тело запроса ЮKassa часто приходит в виде буфера, парсим его
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

    // --- ЛОГИРОВАНИЕ ---
    if (userId === null) {
        console.warn(`⚠️ [Webhook] User ID is NULL (извлечено из метаданных). Value from metadata: ${payment.metadata.userId}.`);
    } else {
        console.log(`[Webhook] User ID для создания билетов: ${userId}`);
    }
    // ----------------------------


    try {
        switch (event.event) {
            case 'payment.succeeded': {
                console.log(`[ЮKassa Success] Платеж ID: ${payment.id} успешен. Запись билетов в БД...`);

                const success = await createTicketRecords(ticketIds, userId);

                if (!success) {
                    console.error("[ЮKassa Webhook] Ошибка записи в БД. Требуется повтор.");
                    return res.status(500).send('Database write error');
                }

                console.log("[ЮKassa Success] Билеты успешно записаны.");
                break;
            }
            case 'payment.canceled': {
                console.log(`[ЮKassa Canceled] Платеж ID: ${payment.id} отменен.`);
                break;
            }
            default:
                console.log(`[ЮKassa Webhook] Тип события ${event.event} игнорируется.`);
        }

        res.status(200).send({ message: 'Уведомление ЮKassa успешно обработано' });

    } catch (error) {
        console.error("Критическая ошибка при обработке Webhook ЮKassa:", error);
        res.status(500).send('Internal Server Error');
    }
});

module.exports = router;