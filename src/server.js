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
const { notifyRedeemUsed, notifyPaymentReceived, notifyNewWebOrder } = require('./services/notifyService');

const app = express();

// =========================================================
// Middleware
// =========================================================
app.use(helmet());

// CORS — strip trailing slash and allow web frontend
const frontendUrl = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
app.use(cors({
    origin: frontendUrl || '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', apiLimiter);

// =========================================================
// PUBLIC: Verify web access password
// =========================================================
app.post('/api/web/verify-password', (req, res) => {
    const { password } = req.body;
    const webPassword = process.env.WEB_ACCESS_PASSWORD || '';
    if (!webPassword) return res.json({ valid: true }); // no password set = open
    if (password === webPassword) return res.json({ valid: true });
    return res.status(401).json({ valid: false, error: 'Password salah' });
});

// =========================================================
// Auth middleware for Admin API (JWT)
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
// PUBLIC: Redeem code + invite email (NO LOGIN REQUIRED)
// Step 1: User enters redeem code → validates and holds
// Step 2: User enters email → uses credit from code and enqueues invite
// =========================================================
app.post('/api/web/redeem-invite', async (req, res) => {
    const { code, email } = req.body;

    if (!code) return res.status(400).json({ error: 'Kode redeem diperlukan' });
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email tidak valid' });

    const targetEmail = email.trim().toLowerCase();

    // Validate code
    const codeDoc = await RedeemCode.findOne({ code: code.toUpperCase(), isUsed: false });
    if (!codeDoc) return res.status(400).json({ error: 'Kode tidak valid atau sudah digunakan' });
    if (codeDoc.expiresAt && new Date() > codeDoc.expiresAt) {
        return res.status(400).json({ error: 'Kode sudah kedaluwarsa' });
    }

    // Check available account
    const account = await Account.findOne({ status: 'active', $expr: { $lt: ['$inviteCount', '$maxInvites'] } });
    if (!account) return res.status(503).json({ error: 'Semua akun sedang penuh. Coba lagi nanti.' });

    // Mark code as used
    codeDoc.isUsed = true;
    codeDoc.usedBy = `web_${targetEmail}`;
    codeDoc.usedAt = new Date();
    await codeDoc.save();

    // Log transaction
    await Transaction.create({
        telegramId: `web_${targetEmail}`,
        type: 'redeem',
        credits: codeDoc.credits,
        redeemCode: code.toUpperCase(),
        description: `Web redeem ${code.toUpperCase()} → invite ${targetEmail}`,
    });

    // Enqueue the invite job
    const { jobId, position } = await enqueue(`web_${targetEmail}`, targetEmail);

    // Notify admin channel
    await notifyRedeemUsed(code.toUpperCase(), codeDoc.credits, 'web');
    await notifyNewWebOrder(targetEmail, 'Redeem Code');

    res.json({
        success: true,
        jobId,
        position,
        message: position > 1
            ? `✅ Antrian ke-${position}. Email ${targetEmail} akan segera diinvite.`
            : `✅ Sedang diproses! Email ${targetEmail} akan segera diinvite.`,
    });
});

// =========================================================
// PUBLIC: Create QRIS payment for email invite (NO LOGIN)
// =========================================================
app.post('/api/web/pay', async (req, res) => {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email tidak valid' });

    const targetEmail = email.trim().toLowerCase();

    // Check available account
    const account = await Account.findOne({ status: 'active', $expr: { $lt: ['$inviteCount', '$maxInvites'] } });
    if (!account) return res.status(503).json({ error: 'Semua akun sedang penuh. Coba lagi nanti.' });

    try {
        // createPayment already creates a Transaction internally, so don't create another
        const payment = await createPayment(`web_${targetEmail}`, 1);

        await notifyNewWebOrder(targetEmail, `QRIS Rp ${payment.amountTotal.toLocaleString('id-ID')}`);

        res.json({
            success: true,
            transactionId: payment.transactionId,
            qrisContent: payment.qrisContent,
            amountTotal: payment.amountTotal,
            amountUnique: payment.amountUnique,
            expiresAt: payment.expiresAt,
            email: targetEmail,
        });
    } catch (err) {
        console.error('[Web Pay] QRIS error:', err.response?.data || err.message);
        res.status(500).json({ error: 'Gagal membuat QRIS: ' + (err.response?.data?.message || err.message) });
    }
});

// =========================================================
// PUBLIC: Check payment status for web order
// =========================================================
app.get('/api/web/pay/status/:transactionId', async (req, res) => {
    const { transactionId } = req.params;

    const txn = await Transaction.findOne({ qrisTransactionId: transactionId, type: 'qris' });
    if (!txn) return res.status(404).json({ error: 'Transaksi tidak ditemukan' });

    res.json({ status: txn.qrisStatus, email: txn.telegramId.replace('web_', '') });
});

// =========================================================
// PUBLIC: Check invite job status (for web polling)
// =========================================================
app.get('/api/web/job/:jobId', async (req, res) => {
    const { jobId } = req.params;
    try {
        const job = await InviteJob.findById(jobId);
        if (!job) return res.status(404).json({ error: 'Job tidak ditemukan' });
        res.json({
            status: job.status,
            result: job.result,
            email: job.targetEmail,
        });
    } catch {
        res.status(400).json({ error: 'Invalid job ID' });
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
            res.json({ success: true, matched: true });

            // Check if this is a web order (telegramId starts with "web_")
            if (result.telegramId && result.telegramId.startsWith('web_')) {
                const email = result.telegramId.replace('web_', '');
                // Auto-enqueue invite for web payment
                await enqueue(result.telegramId, email);
                await notifyPaymentReceived(result.amount || CREDIT_PRICE, result.creditsAdded || 1, 'web');
            } else {
                // Telegram user — notify via bot
                try {
                    const { bot } = require('./bot/userHandlers');
                    await bot.api.sendMessage(result.telegramId,
                        `✅ *Pembayaran Diterima!*\n\n💎 +${result.creditsAdded} kredit telah ditambahkan!\n💰 Saldo: *${result.newBalance} kredit*\n\nGunakan /gpti email@example.com untuk invite sekarang!`,
                        { parse_mode: 'Markdown' }
                    );
                    await notifyPaymentReceived(result.amount || CREDIT_PRICE, result.creditsAdded, 'telegram');
                } catch (_) { }
            }
        } else {
            res.json({ success: true, matched: result.matched });
        }
    } catch (err) {
        console.error('[Webhook] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// =========================================================
// PUBLIC: Server status (for web)
// =========================================================
app.get('/api/web/status', async (req, res) => {
    const activeAccounts = await Account.countDocuments({ status: 'active', $expr: { $lt: ['$inviteCount', '$maxInvites'] } });
    const pendingJobs = await InviteJob.countDocuments({ status: 'queued' });
    res.json({
        online: activeAccounts > 0,
        availableSlots: activeAccounts,
        queueLength: pendingJobs,
        pricePerInvite: CREDIT_PRICE,
    });
});

// =========================================================
// Admin: Auth login (kept for admin panel)
// =========================================================
app.post('/api/auth/login', async (req, res) => {
    const { telegramId } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

    const adminIds = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim());
    if (!adminIds.includes(String(telegramId))) {
        return res.status(403).json({ error: 'Admin only' });
    }

    const token = jwt.sign({ telegramId: String(telegramId), isAdmin: true }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, isAdmin: true });
});

// =========================================================
// Admin endpoints (all require auth)
// =========================================================
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
    res.json({ totalUsers, totalInvites, todayInvites, totalRevenue: revenueData[0]?.total || 0, accounts: { active: acMap['active'] || 0, full: acMap['full'] || 0, error: acMap['error'] || 0 }, pendingJobs });
});

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
    const { page = 1, limit = 20, search } = req.query;
    const query = search ? { $or: [{ username: { $regex: search, $options: 'i' } }, { telegramId: search }] } : {};
    const users = await User.find(query).sort({ credits: -1 }).skip((page - 1) * limit).limit(parseInt(limit));
    const total = await User.countDocuments(query);
    res.json({ users, total, page: parseInt(page), limit: parseInt(limit) });
});

app.post('/api/admin/users/:telegramId/credits', authMiddleware, adminMiddleware, async (req, res) => {
    const { amount, action } = req.body;
    const user = await User.findOneAndUpdate(
        { telegramId: req.params.telegramId },
        action === 'set' ? { $set: { credits: amount } } : { $inc: { credits: amount } },
        { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    await Transaction.create({ telegramId: req.params.telegramId, type: 'admin_gift', credits: amount, description: `Admin ${action === 'set' ? 'set' : 'gift'} ${amount} kredit` });
    res.json({ success: true, newBalance: user.credits });
});

app.get('/api/admin/accounts', authMiddleware, adminMiddleware, async (req, res) => {
    const accounts = await Account.find().select('-password -twoFASecret -sessionData').sort({ createdAt: -1 });
    res.json(accounts);
});

app.post('/api/admin/accounts', authMiddleware, adminMiddleware, async (req, res) => {
    const { email, password, twoFASecret = '' } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const existing = await Account.findOne({ email });
    if (existing) return res.status(400).json({ error: 'Email sudah terdaftar' });
    const acc = await Account.create({ email, password, twoFASecret });
    res.json({ success: true, id: acc._id });
});

app.delete('/api/admin/accounts/:id', authMiddleware, adminMiddleware, async (req, res) => {
    await Account.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

app.post('/api/admin/accounts/:id/reset', authMiddleware, adminMiddleware, async (req, res) => {
    const acc = await Account.findByIdAndUpdate(req.params.id, { inviteCount: 0, status: 'active' }, { new: true });
    if (!acc) return res.status(404).json({ error: 'Account not found' });
    res.json({ success: true });
});

app.post('/api/admin/codes/generate', authMiddleware, adminMiddleware, async (req, res) => {
    const { count = 1, credits = 1, prefix = 'GPTI', note = '' } = req.body;
    if (count > 100) return res.status(400).json({ error: 'Max 100 codes per request' });
    const { generateCodes } = require('./bot/adminHandlers');
    const codes = await generateCodes(req.user.telegramId, count, credits, prefix, note);
    res.json({ success: true, codes });
});

app.get('/api/admin/codes', authMiddleware, adminMiddleware, async (req, res) => {
    const { used } = req.query;
    const filter = used !== undefined ? { isUsed: used === 'true' } : {};
    const codes = await RedeemCode.find(filter).sort({ createdAt: -1 }).limit(100);
    res.json(codes);
});

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
