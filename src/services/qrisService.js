const axios = require('axios');
const crypto = require('crypto');
const Transaction = require('../models/Transaction');
const User = require('../models/User');

const QRIS_API_URL = process.env.QRIS_API_URL || 'https://qris.hubify.store/api';
const QRIS_API_KEY = process.env.QRIS_API_KEY;
const CREDIT_PRICE = parseInt(process.env.CREDIT_PRICE || '5000');

const qrisClient = axios.create({
    baseURL: QRIS_API_URL,
    headers: {
        'Authorization': `Bearer ${QRIS_API_KEY}`,
        'Content-Type': 'application/json',
    },
    timeout: 15000,
});

/**
 * Create a QRIS transaction for a user wanting to buy credits
 * @param {string} telegramId
 * @param {number} creditsToBuy
 * @returns {Object} transaction info including QRIS content
 */
async function createPayment(telegramId, creditsToBuy) {
    const amount = creditsToBuy * CREDIT_PRICE;
    const orderId = `GPTI-${telegramId}-${Date.now()}`;

    const response = await qrisClient.post('/create-transaction', {
        amount,
        order_id: orderId,
        customer_id: `telegram_${telegramId}`,
    });

    const data = response.data;

    // Save pending transaction to DB
    await Transaction.create({
        telegramId,
        type: 'qris',
        credits: creditsToBuy,
        amount: data.amount_original,
        qrisTransactionId: data.transaction_id,
        qrisOrderId: orderId,
        qrisStatus: 'pending',
        description: `Beli ${creditsToBuy} kredit via QRIS`,
    });

    return {
        transactionId: data.transaction_id,
        amountOriginal: data.amount_original,
        amountUnique: data.amount_unique,
        amountTotal: data.amount_total,
        qrisContent: data.qris_content,
        expiresAt: data.expires_at,
        orderId,
        creditsToBuy,
    };
}

/**
 * Check if a payment has been completed
 * @param {string} qrisTransactionId
 */
async function checkPayment(qrisTransactionId) {
    const response = await qrisClient.get(`/check-status/${qrisTransactionId}`);
    return response.data.transaction;
}

/**
 * Handle inbound webhook from QRIS gateway when payment completes
 * - Adds credits to user
 * - Updates transaction status
 */
async function handleWebhookPayload(payload) {
    const { customer_id, order_id, amount, status } = payload;

    if (status !== 'completed') return { matched: false };

    // Extract telegram ID from customer_id: "telegram_<id>"
    const telegramId = customer_id?.replace('telegram_', '');
    if (!telegramId) return { matched: false };

    // Find the pending transaction
    const txn = await Transaction.findOne({
        qrisOrderId: order_id,
        qrisStatus: 'pending',
        telegramId,
    });

    if (!txn) return { matched: false };

    // Already processed guard
    if (txn.qrisStatus === 'paid') return { matched: true, alreadyProcessed: true };

    // Update transaction
    txn.qrisStatus = 'paid';
    await txn.save();

    // Add credits to user
    const user = await User.findOneAndUpdate(
        { telegramId },
        { $inc: { credits: txn.credits } },
        { new: true, upsert: true }
    );

    return {
        matched: true,
        telegramId,
        creditsAdded: txn.credits,
        newBalance: user.credits,
        transactionId: txn.qrisTransactionId,
    };
}

/**
 * Verify webhook signature (simple or HMAC)
 */
function verifyWebhookSecret(req) {
    const secret = process.env.QRIS_WEBHOOK_SECRET;
    if (!secret) return true; // skip if not configured
    const receivedSecret = req.headers['x-webhook-secret'];
    return receivedSecret === secret;
}

module.exports = { createPayment, checkPayment, handleWebhookPayload, verifyWebhookSecret, CREDIT_PRICE };
