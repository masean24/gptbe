const axios = require('axios');
const crypto = require('crypto');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const WebUser = require('../models/WebUser');

const QRIS_API_URL = process.env.QRIS_API_URL || 'https://qris.hubify.store/api';
const QRIS_API_KEY = process.env.QRIS_API_KEY;

// Tier pricing
const TIER_PRICES = {
    basic: parseInt(process.env.TIER_BASIC_PRICE || '5000'),
    standard: parseInt(process.env.TIER_STANDARD_PRICE || '10000'),
    premium: parseInt(process.env.TIER_PREMIUM_PRICE || '15000'),
};

const TIER_GUARANTEE_DAYS = {
    basic: 0,
    standard: 14,
    premium: 30,
};

// Backward compat
const CREDIT_PRICE = TIER_PRICES.basic;

function getTierPrice(tier) {
    return TIER_PRICES[tier] || TIER_PRICES.basic;
}

function getTierGuaranteeDays(tier) {
    return TIER_GUARANTEE_DAYS[tier] || 0;
}

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
 * @param {string} tier - 'basic', 'standard', or 'premium'
 */
async function createPayment(telegramId, creditsToBuy, tier = 'basic') {
    const pricePerCredit = getTierPrice(tier);
    const amount = creditsToBuy * pricePerCredit;
    const cleanId = telegramId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const orderId = `GPTI-${cleanId}-${Date.now()}`;

    const customerId = telegramId.startsWith('web_')
        ? `web_${Date.now()}`
        : `tg_${telegramId}`;

    const response = await qrisClient.post('/create-transaction', {
        amount,
        order_id: orderId,
        customer_id: customerId,
    });

    const data = response.data;

    // Save pending transaction to DB
    await Transaction.create({
        telegramId,
        type: 'qris',
        credits: creditsToBuy,
        amount: data.amount_original,
        tier,
        qrisTransactionId: data.transaction_id,
        qrisOrderId: orderId,
        qrisStatus: 'pending',
        description: `Beli ${creditsToBuy} kredit ${tier} via QRIS`,
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
        tier,
    };
}

/**
 * Check if a payment has been completed
 */
async function checkPayment(qrisTransactionId) {
    const response = await qrisClient.get(`/check-status/${qrisTransactionId}`);
    return response.data.transaction;
}

/**
 * Handle inbound webhook from QRIS gateway when payment completes
 */
async function handleWebhookPayload(payload) {
    const { order_id, status } = payload;

    if (status !== 'completed') return { matched: false };
    if (!order_id) return { matched: false };

    const txn = await Transaction.findOneAndUpdate(
        {
            qrisOrderId: order_id,
            qrisStatus: 'pending',
        },
        {
            $set: {
                qrisStatus: 'paid',
            },
        },
        { new: true }
    );

    if (!txn) {
        const existingTxn = await Transaction.findOne({ qrisOrderId: order_id });
        if (existingTxn?.qrisStatus === 'paid') {
            return { matched: true, alreadyProcessed: true };
        }
        return { matched: false };
    }

    const telegramId = txn.telegramId;
    const tier = txn.tier || 'basic';
    const isWebOrder = telegramId.startsWith('web_') || telegramId.startsWith('webuser_');

    // Add tier-specific credits to user
    let newBalance = 0;
    if (telegramId.startsWith('webuser_')) {
        const webUserId = telegramId.replace('webuser_', '');
        const creditField = `credits_${tier}`;
        const webUser = await WebUser.findByIdAndUpdate(
            webUserId,
            { $inc: { [creditField]: txn.credits } },
            { new: true }
        );
        if (webUser) {
            newBalance = (webUser.credits_basic || 0) + (webUser.credits_standard || 0) + (webUser.credits_premium || 0);
        }
    } else if (!isWebOrder) {
        const creditField = `credits_${tier}`;
        const user = await User.findOneAndUpdate(
            { telegramId },
            { $inc: { [creditField]: txn.credits } },
            { new: true, upsert: true }
        );
        newBalance = user.credits_basic + user.credits_standard + user.credits_premium;
    }

    return {
        matched: true,
        telegramId,
        creditsAdded: txn.credits,
        newBalance,
        amount: txn.amount,
        tier,
        transactionId: txn.qrisTransactionId,
    };
}

/**
 * Verify webhook signature
 */
function verifyWebhookSecret(req) {
    const secret = process.env.QRIS_WEBHOOK_SECRET;
    if (!secret) return true;
    const receivedSecret = req.headers['x-webhook-secret'];
    return receivedSecret === secret;
}

module.exports = {
    createPayment, checkPayment, handleWebhookPayload, verifyWebhookSecret,
    CREDIT_PRICE, TIER_PRICES, TIER_GUARANTEE_DAYS, getTierPrice, getTierGuaranteeDays
};
