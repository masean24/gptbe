const mongoose = require('mongoose');

const webUserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true }, // bcrypt hashed
    // Tier-based credits
    credits_basic: { type: Number, default: 0, min: 0 },
    credits_standard: { type: Number, default: 0, min: 0 },
    credits_premium: { type: Number, default: 0, min: 0 },
    totalInvites: { type: Number, default: 0 },
    freeCreditsGiven: { type: Boolean, default: false },
    isApproved: { type: Boolean, default: false },
    isBlocked: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    lastLoginAt: { type: Date, default: null },
});

// Virtual for total credits (backward compat)
webUserSchema.virtual('credits').get(function () {
    return this.credits_basic + this.credits_standard + this.credits_premium;
});

webUserSchema.set('toJSON', {
    virtuals: true,
    transform: (doc, ret) => { delete ret.password; return ret; }
});
webUserSchema.set('toObject', { virtuals: true });

webUserSchema.index({ email: 1 });
webUserSchema.index({ createdAt: -1 });

module.exports = mongoose.model('WebUser', webUserSchema);
