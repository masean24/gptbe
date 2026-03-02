const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    username: { type: String, default: null },
    firstName: { type: String, default: null },
    credits: { type: Number, default: 0, min: 0 },
    totalInvites: { type: Number, default: 0 },
    isBlocked: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    lastActivityAt: { type: Date, default: Date.now },
});

userSchema.index({ telegramId: 1 });

module.exports = mongoose.model('User', userSchema);
