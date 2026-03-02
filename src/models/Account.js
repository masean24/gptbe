const mongoose = require('mongoose');

const accountSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    twoFASecret: { type: String, default: '' },
    inviteCount: { type: Number, default: 0 },
    maxInvites: { type: Number, default: 4 },
    status: { type: String, enum: ['active', 'full', 'error'], default: 'active' },
    hasSession: { type: Boolean, default: false },
    sessionData: { type: String, default: null }, // JSON stringified Playwright session
    lastUsed: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
    notes: { type: String, default: '' },
});

accountSchema.index({ status: 1, inviteCount: 1 });

module.exports = mongoose.model('Account', accountSchema);
