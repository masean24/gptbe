const mongoose = require('mongoose');

const webUserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true }, // bcrypt hashed
    credits: { type: Number, default: 0, min: 0 },
    totalInvites: { type: Number, default: 0 },
    freeCreditsGiven: { type: Boolean, default: false },
    isApproved: { type: Boolean, default: false }, // admin approved for free credit
    isBlocked: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    lastLoginAt: { type: Date, default: null },
});

webUserSchema.index({ email: 1 });
webUserSchema.index({ createdAt: -1 });

module.exports = mongoose.model('WebUser', webUserSchema);
