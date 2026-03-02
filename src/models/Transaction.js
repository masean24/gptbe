const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    telegramId: { type: String, required: true },
    type: { type: String, enum: ['qris', 'redeem', 'admin_gift', 'invite_used'], required: true },
    credits: { type: Number, required: true }, // positive = added, negative = used
    amount: { type: Number, default: 0 }, // IDR for qris payments
    // QRIS specific
    qrisTransactionId: { type: String, default: null },
    qrisOrderId: { type: String, default: null },
    qrisStatus: { type: String, enum: ['pending', 'paid', 'expired', null], default: null },
    // Redeem specific
    redeemCode: { type: String, default: null },
    // Invite specific
    invitedEmail: { type: String, default: null },
    description: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
});

transactionSchema.index({ telegramId: 1, createdAt: -1 });
transactionSchema.index({ qrisTransactionId: 1 });

module.exports = mongoose.model('Transaction', transactionSchema);
