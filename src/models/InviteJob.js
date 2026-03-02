const mongoose = require('mongoose');

const inviteJobSchema = new mongoose.Schema({
    telegramId: { type: String, required: true },
    targetEmail: { type: String, required: true },
    status: { type: String, enum: ['queued', 'processing', 'done', 'failed'], default: 'queued' },
    accountId: { type: String, default: null }, // which ChatGPT account used
    result: { type: String, default: null }, // success/error message
    createdAt: { type: Date, default: Date.now },
    processedAt: { type: Date, default: null },
});

inviteJobSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('InviteJob', inviteJobSchema);
