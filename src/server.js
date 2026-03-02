require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('./models/User');
const Account = require('./models/Account');
const RedeemCode = require('./models/RedeemCode');
const Transaction = require('./models/Transaction');
const InviteJob = require('./models/InviteJob');
const { handleWebhookPayload, verifyWebhookSecret, createPayment, CREDIT_PRICE } = require('./services/qrisService');
const { enqueue } = require('./services/queueService');

const app = express();

// =========================================================
// Middleware
// =========================================================
app.use(helmet());
app.use(cors({
    origin: process.env.FRONTEND_URL || '*',
    credentials: true,
}));
app.use(express.json());

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', apiLimiter);

// =========================================================
// Auth middleware for Web API (JWT)
// =========================================================
function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token provided' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (_) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

function adminMiddleware(req, res, next) {
    const adminIds = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim());
    if (!adminIds.includes(String(req.user?.telegramId))) {
        return res.status(403).json({ error: 'Admin only' });
    }
    next();
}

// =========================================================
// Public: Login via Telegram ID (simple auth for web)
// Returns a JWT token
// =========================================================
app.post('/api/auth/login', async (req, res) => {
    const { telegramId, accessCode } = req.body; // accessCode optional future use
    if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

    const user = await User.findOneAndUpdate(
        { telegramId: String(telegramId) },
        { lastActivityAt: new Date() },
        { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found. Start the bot first.' });
    if (user.isBlocked) return res.status(403).json({ error: 'Account blocked.' });

    const adminIds = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim());
    const isAdmin = adminIds.includes(String(telegramId));

    const token = jwt.sign(
        { telegramId: user.telegramId, username: user.username, isAdmin },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
    );

    res.json({ token, user: { telegramId: user.telegramId, username: user.username, credits: user.credits, isAdmin } });
});

// =========================================================
// User: Get own profile
// =========================================================
app.get('/api/me', authMiddleware, async (req, res) => {
    const user = await User.findOne({ telegramId: req.user.telegramId });
    if (!user) return res.status(404).json({ error: 'Not found' });
    const adminIds = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim());
    res.json({
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        credits: user.credits,
        totalInvites: user.totalInvites,
        isAdmin: adminIds.includes(String(user.telegramId)),
    });
});

// =========================================================
// User: Submit invite
// =========================================================
app.post('/api/invite', authMiddleware, async (req, res) => {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email tidak valid' });

    const user = await User.findOne({ telegramId: req.user.telegramId });
    if (!user || user.credits < 1) {
        return res.status(400).json({ error: 'Saldo kredit tidak cukup' });
    }

    const account = await Account.findOne({ status: 'active', $expr: { $lt: ['$inviteCount', '$maxInvites'] } });
    if (!account) return res.status(503).json({ error: 'Tidak ada akun tersedia saat ini' });

    const { jobId, position } = await enqueue(String(req.user.telegramId), email.trim().toLowerCase());
    res.json({ jobId, position, message: position > 1 ? `Antrian ke-${position}` : 'Sedang diproses...' });
});

// =========================================================
// User: Redeem code
// =========================================================
app.post('/api/redeem', authMiddleware, async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Kode diperlukan' });

    const codeDoc = await RedeemCode.findOne({ code: code.toUpperCase(), isUsed: false });
    if (!codeDoc) return res.status(400).json({ error: 'Kode tidak valid atau sudah digunakan' });
    if (codeDoc.expiresAt && new Date() > codeDoc.expiresAt) {
        return res.status(400).json({ error: 'Kode sudah kedaluwarsa' });
    }

    codeDoc.isUsed = true;
    codeDoc.usedBy = req.user.telegramId;
    codeDoc.usedAt = new Date();
    await codeDoc.save();

    const user = await User.findOneAndUpdate(
        { telegramId: req.user.telegramId },
        { $inc: { credits: codeDoc.credits } },
        { new: true }
    );

    await Transaction.create({
        telegramId: req.user.telegramId,
        type: 'redeem',
        credits: codeDoc.credits,
        redeemCode: code.toUpperCase(),
        description: `Web redeem ${code.toUpperCase()} (+${codeDoc.credits} kredit)`,
    });

    res.json({ success: true, creditsAdded: codeDoc.credits, newBalance: user.credits });
});

// =========================================================
// User: Create QRIS payment
// =========================================================
app.post('/api/payment/create', authMiddleware, async (req, res) => {
    const { credits } = req.body;
    const creditsToBuy = parseInt(credits);
    if (!creditsToBuy || creditsToBuy < 1 || creditsToBuy > 50) {
        return res.status(400).json({ error: 'Jumlah kredit tidak valid (1-50)' });
    }

    try {
        const payment = await createPayment(req.user.telegramId, creditsToBuy);
        res.json(payment);
    } catch (err) {
        res.status(500).json({ error: 'Gagal membuat QRIS: ' + err.message });
    }
});

// =========================================================
// QRIS Webhook (inbound from qris.hubify.store)
// =========================================================
app.post('/api/webhooks/qris', async (req, res) => {
    if (!verifyWebhookSecret(req)) {
        return res.status(401).json({ error: 'Invalid webhook secret' });
    }

    try {
        const result = await handleWebhookPayload(req.body);

        if (result.matched && !result.alreadyProcessed) {
            // Send Telegram notification to user
            res.json({ success: true, matched: true });

            // We import bot lazily to avoid circular dep
            try {
                const { bot } = require('./bot/userHandlers');
                await bot.api.sendMessage(result.telegramId,
                    `✅ *Pembayaran Diterima!*\n\n💎 +${result.creditsAdded} kredit telah ditambahkan!\n💰 Saldo: *${result.newBalance} kredit*\n\nGunakan /gpti email@example.com untuk invite sekarang!`,
                    { parse_mode: 'Markdown' }
                );
            } catch (_) { }
        } else {
            res.json({ success: true, matched: result.matched });
        }
    } catch (err) {
        console.error('[Webhook] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// =========================================================
// User: Transaction history
// =========================================================
app.get('/api/transactions', authMiddleware, async (req, res) => {
    const txns = await Transaction.find({ telegramId: req.user.telegramId })
        .sort({ createdAt: -1 }).limit(20);
    res.json(txns);
});

// =========================================================
// Admin: Get all users
// =========================================================
app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
    const { page = 1, limit = 20, search } = req.query;
    const query = search ? { $or: [{ username: { $regex: search, $options: 'i' } }, { telegramId: search }] } : {};
    const users = await User.find(query).sort({ credits: -1 }).skip((page - 1) * limit).limit(parseInt(limit));
    const total = await User.countDocuments(query);
    res.json({ users, total, page: parseInt(page), limit: parseInt(limit) });
});

// Admin: Update user credits
app.post('/api/admin/users/:telegramId/credits', authMiddleware, adminMiddleware, async (req, res) => {
    const { amount, action } = req.body; // action: 'add' | 'set'
    const user = await User.findOneAndUpdate(
        { telegramId: req.params.telegramId },
        action === 'set' ? { $set: { credits: amount } } : { $inc: { credits: amount } },
        { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    await Transaction.create({
        telegramId: req.params.telegramId,
        type: 'admin_gift',
        credits: amount,
        description: `Admin web ${action === 'set' ? 'set' : 'gift'} ${amount} kredit`,
    });
    res.json({ success: true, newBalance: user.credits });
});

// Admin: Get accounts
app.get('/api/admin/accounts', authMiddleware, adminMiddleware, async (req, res) => {
    const accounts = await Account.find().select('-password -twoFASecret -sessionData').sort({ createdAt: -1 });
    res.json(accounts);
});

// Admin: Add account
app.post('/api/admin/accounts', authMiddleware, adminMiddleware, async (req, res) => {
    const { email, password, twoFASecret = '' } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const existing = await Account.findOne({ email });
    if (existing) return res.status(400).json({ error: 'Email sudah terdaftar' });
    const acc = await Account.create({ email, password, twoFASecret });
    res.json({ success: true, id: acc._id });
});

// Admin: Delete account
app.delete('/api/admin/accounts/:id', authMiddleware, adminMiddleware, async (req, res) => {
    await Account.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

// Admin: Reset account
app.post('/api/admin/accounts/:id/reset', authMiddleware, adminMiddleware, async (req, res) => {
    const acc = await Account.findByIdAndUpdate(req.params.id, { inviteCount: 0, status: 'active' }, { new: true });
    if (!acc) return res.status(404).json({ error: 'Account not found' });
    res.json({ success: true });
});

// Admin: Generate redeem codes
app.post('/api/admin/codes/generate', authMiddleware, adminMiddleware, async (req, res) => {
    const { count = 1, credits = 1, prefix = 'GPTI', note = '' } = req.body;
    if (count > 100) return res.status(400).json({ error: 'Max 100 codes per request' });
    const { generateCodes } = require('./bot/adminHandlers');
    const codes = await generateCodes(req.user.telegramId, count, credits, prefix, note);
    res.json({ success: true, codes });
});

// Admin: List unused codes
app.get('/api/admin/codes', authMiddleware, adminMiddleware, async (req, res) => {
    const { used } = req.query;
    const filter = used !== undefined ? { isUsed: used === 'true' } : {};
    const codes = await RedeemCode.find(filter).sort({ createdAt: -1 }).limit(100);
    res.json(codes);
});

// Admin: Stats dashboard
app.get('/api/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const [totalUsers, totalInvites, todayInvites, accountStats, revenueData, pendingJobs] = await Promise.all([
        User.countDocuments(),
        Transaction.countDocuments({ type: 'invite_used' }),
        Transaction.countDocuments({ type: 'invite_used', createdAt: { $gte: todayStart } }),
        Account.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
        Transaction.aggregate([{ $match: { type: 'qris', qrisStatus: 'paid' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
        InviteJob.countDocuments({ status: 'queued' }),
    ]);

    const acMap = {};
    accountStats.forEach(s => acMap[s._id] = s.count);

    res.json({
        totalUsers,
        totalInvites,
        todayInvites,
        totalRevenue: revenueData[0]?.total || 0,
        accounts: { active: acMap['active'] || 0, full: acMap['full'] || 0, error: acMap['error'] || 0 },
        pendingJobs,
    });
});

// Admin: Broadcast via API
app.post('/api/admin/broadcast', authMiddleware, adminMiddleware, async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    const users = await User.find({ isBlocked: false }).select('telegramId');
    const { bot } = require('./bot/userHandlers');

    let sent = 0, failed = 0;
    for (const user of users) {
        try {
            await bot.api.sendMessage(user.telegramId, `📢 *PENGUMUMAN*\n\n${message}`, { parse_mode: 'Markdown' });
            sent++;
            await new Promise(r => setTimeout(r, 50));
        } catch (_) { failed++; }
    }
    res.json({ success: true, sent, failed, total: users.length });
});

// =========================================================
// Health check
// =========================================================
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

function startServer(bot) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`🚀 API Server running on port ${PORT}`));
}

module.exports = { startServer };
