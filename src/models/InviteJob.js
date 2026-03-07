const mongoose = require('mongoose');

const inviteJobSchema = new mongoose.Schema({
    telegramId: { type: String, required: true },
    targetEmail: { type: String, required: true },
    status: { type: String, enum: ['queued', 'processing', 'done', 'failed'], default: 'queued' },
    accountId: { type: String, default: null }, // which ChatGPT account used
    result: { type: String, default: null }, // success/error message
    // Tier & Guarantee
    tier: { type: String, enum: ['basic', 'standard', 'premium'], default: 'basic' },
    guaranteeDays: { type: Number, default: 0 },
    guaranteeUntil: { type: Date, default: null },
    guaranteeClaimed: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    processedAt: { type: Date, default: null },
});

inviteJobSchema.index({ status: 1, createdAt: 1 });
inviteJobSchema.index({ telegramId: 1, status: 1 });

module.exports = mongoose.model('InviteJob', inviteJobSchema);
