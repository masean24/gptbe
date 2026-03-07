const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
    userId: { type: String, required: true }, // webuser_xxx or telegramId
    userEmail: { type: String, default: '' },
    action: {
        type: String,
        enum: ['register', 'login', 'approve', 'redeem', 'buy_credit', 'invite', 'payment_received', 'block', 'unblock', 'guarantee_claim'],
        required: true
    },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    ip: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
});

activityLogSchema.index({ userId: 1, createdAt: -1 });
activityLogSchema.index({ action: 1, createdAt: -1 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
