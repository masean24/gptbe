const mongoose = require('mongoose');

const redeemCodeSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true, uppercase: true },
    credits: { type: Number, required: true, min: 1 },
    isUsed: { type: Boolean, default: false },
    usedBy: { type: String, default: null }, // telegramId
    usedAt: { type: Date, default: null },
    createdBy: { type: String, default: 'admin' }, // telegramId of admin
    note: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null },
});

redeemCodeSchema.index({ code: 1 });
redeemCodeSchema.index({ isUsed: 1 });

module.exports = mongoose.model('RedeemCode', redeemCodeSchema);
