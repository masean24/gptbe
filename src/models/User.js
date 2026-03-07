const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    username: { type: String, default: null },
    firstName: { type: String, default: null },
    // Tier-based credits
    credits_basic: { type: Number, default: 0, min: 0 },
    credits_standard: { type: Number, default: 0, min: 0 },
    credits_premium: { type: Number, default: 0, min: 0 },
    totalInvites: { type: Number, default: 0 },
    isBlocked: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    lastActivityAt: { type: Date, default: Date.now },
});

// Virtual for total credits (backward compat)
userSchema.virtual('credits').get(function () {
    return this.credits_basic + this.credits_standard + this.credits_premium;
});

userSchema.index({ telegramId: 1 });

module.exports = mongoose.model('User', userSchema);
