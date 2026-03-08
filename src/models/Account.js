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
    assignedProxy: { type: String, default: '' }, // per-account proxy, e.g. "http://user:pass@host:port"
    reservedSlots: { type: Number, default: 0 },  // slots reserved by in-flight jobs (atomic, decremented in finally)
    vpnNamespace: { type: String, default: null }, // linux netns name, e.g. "ns_vpn_0"
    vpnAssignedAt: { type: Date, default: null },
});

accountSchema.index({ status: 1, inviteCount: 1 });

module.exports = mongoose.model('Account', accountSchema);
