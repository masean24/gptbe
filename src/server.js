require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('./models/User');
const WebUser = require('./models/WebUser');
const Account = require('./models/Account');
const RedeemCode = require('./models/RedeemCode');
const Transaction = require('./models/Transaction');
const Settings = require('./models/Settings');
const ActivityLog = require('./models/ActivityLog');
const InviteJob = require('./models/InviteJob');
const { handleWebhookPayload, verifyWebhookSecret, createPayment, CREDIT_PRICE, TIER_PRICES, getTierPrice, getTierGuaranteeDays } = require('./services/qrisService');
const { enqueue } = require('./services/queueService');
const { notifyRedeemUsed, notifyPaymentReceived, notifyNewWebOrder, notifyNewWebRegistration } = require('./services/notifyService');
const { sendRedeemCode } = require('./services/emailService');

const app = express();

// =========================================================
// Middleware
// =========================================================
app.set('trust proxy', 1);
app.use(helmet());

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

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

// Allowed email domains for web registration
const ALLOWED_DOMAINS = ['gmail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'yahoo.co.id'];

// =========================================================
// Auth middleware — supports both admin JWT and web user JWT
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
    if (!req.user?.isAdmin) {
        return res.status(403).json({ error: 'Admin only' });
    }
    next();
}

function webUserMiddleware(req, res, next) {
    if (!req.user?.webUserId) {
        return res.status(403).json({ error: 'Web user auth required' });
    }
    next();
}

// =========================================================
// PUBLIC: Web Auth — Register
// =========================================================
app.post('/api/web/auth/register', authLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email dan password diperlukan' });
        if (password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter' });

        const cleanEmail = email.trim().toLowerCase();
        const domain = cleanEmail.split('@')[1];

        if (!domain || !ALLOWED_DOMAINS.includes(domain)) {
            return res.status(400).json({ error: 'Hanya gmail.com, outlook.com, dan yahoo.com yang diperbolehkan' });
        }

        const existing = await WebUser.findOne({ email: cleanEmail });
        if (existing) return res.status(400).json({ error: 'Email sudah terdaftar' });

        const hashed = await bcrypt.hash(password, 12);
        const newUser = await WebUser.create({ email: cleanEmail, password: hashed });

        // Log activity
        await ActivityLog.create({ userId: `webuser_${newUser._id}`, userEmail: cleanEmail, action: 'register', ip: req.ip });

        // Notify admin channel
        await notifyNewWebRegistration(cleanEmail);

        res.json({ success: true, message: 'Registrasi berhasil! Silakan login.' });
    } catch (err) {
        console.error('[Register] Error:', err.message);
        res.status(500).json({ error: 'Gagal registrasi' });
    }
});

// =========================================================
// PUBLIC: Web Auth — Login
// =========================================================
app.post('/api/web/auth/login', authLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email dan password diperlukan' });

        const cleanEmail = email.trim().toLowerCase();
        const user = await WebUser.findOne({ email: cleanEmail });
        if (!user) return res.status(401).json({ error: 'Email atau password salah' });
        if (user.isBlocked) return res.status(403).json({ error: 'Akun diblokir. Hubungi admin.' });

        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(401).json({ error: 'Email atau password salah' });

        user.lastLoginAt = new Date();
        await user.save();

        // Log activity
        await ActivityLog.create({ userId: `webuser_${user._id}`, userEmail: user.email, action: 'login', ip: req.ip }).catch(() => { });

        const token = jwt.sign(
            { webUserId: String(user._id), email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({
            token,
            user: {
                id: user._id,
                email: user.email,
                credits: user.credits,
                credits_basic: user.credits_basic,
                credits_standard: user.credits_standard,
                credits_premium: user.credits_premium,
                totalInvites: user.totalInvites,
                isApproved: user.isApproved,
                freeCreditsGiven: user.freeCreditsGiven,
                createdAt: user.createdAt,
            },
        });
    } catch (err) {
        console.error('[Login] Error:', err.message);
        res.status(500).json({ error: 'Gagal login' });
    }
});

// =========================================================
// Web User: Get current user info
// =========================================================
app.get('/api/web/auth/me', authMiddleware, webUserMiddleware, async (req, res) => {
    try {
        const user = await WebUser.findById(req.user.webUserId).select('-password');
        if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
        res.json({
            id: user._id,
            email: user.email,
            credits: user.credits,
            totalInvites: user.totalInvites,
            isApproved: user.isApproved,
            freeCreditsGiven: user.freeCreditsGiven,
            isBlocked: user.isBlocked,
            createdAt: user.createdAt,
            lastLoginAt: user.lastLoginAt,
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// =========================================================
// Web User: Dashboard data
// =========================================================
app.get('/api/web/user/dashboard', authMiddleware, webUserMiddleware, async (req, res) => {
    try {
        const user = await WebUser.findById(req.user.webUserId).select('-password');
        if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });

        const recentTxns = await Transaction.find({ telegramId: `webuser_${user._id}` })
            .sort({ createdAt: -1 }).limit(10);

        const seatAgg = await Account.aggregate([{ $match: { status: 'active', $expr: { $lt: ['$inviteCount', '$maxInvites'] } } }, { $group: { _id: null, totalSeats: { $sum: { $subtract: ['$maxInvites', '$inviteCount'] } } } }]);
        const availableSeats = seatAgg[0]?.totalSeats || 0;
        const pendingJobs = await InviteJob.countDocuments({ status: 'queued' });

        res.json({
            user: {
                id: user._id,
                email: user.email,
                credits: user.credits,
                credits_basic: user.credits_basic,
                credits_standard: user.credits_standard,
                credits_premium: user.credits_premium,
                totalInvites: user.totalInvites,
                isApproved: user.isApproved,
                freeCreditsGiven: user.freeCreditsGiven,
                isBlocked: user.isBlocked,
            },
            recentTransactions: recentTxns,
            serverStatus: {
                online: availableSeats > 0,
                availableSlots: availableSeats,
                queueLength: pendingJobs,
                tierPrices: TIER_PRICES,
            },
        });
    } catch (err) {
        console.error('[Dashboard] Error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// =========================================================
// Web User: Transaction history
// =========================================================
app.get('/api/web/user/transactions', authMiddleware, webUserMiddleware, async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const user = await WebUser.findById(req.user.webUserId);
        if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });

        const userId = `webuser_${user._id}`;
        const txns = await Transaction.find({ telegramId: userId })
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit));
        const total = await Transaction.countDocuments({ telegramId: userId });

        res.json({ transactions: txns, total, page: parseInt(page), limit: parseInt(limit) });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// =========================================================
// Web User: Redeem code (adds credits to basic tier)
// =========================================================
app.post('/api/web/user/redeem', authMiddleware, webUserMiddleware, async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) return res.status(400).json({ error: 'Kode redeem diperlukan' });

        const user = await WebUser.findById(req.user.webUserId);
        if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });

        const codeDoc = await RedeemCode.findOne({ code: code.toUpperCase(), isUsed: false });
        if (!codeDoc) return res.status(400).json({ error: 'Kode tidak valid atau sudah digunakan' });
        if (codeDoc.expiresAt && new Date() > codeDoc.expiresAt) {
            return res.status(400).json({ error: 'Kode sudah kedaluwarsa' });
        }

        // Mark code as used
        codeDoc.isUsed = true;
        codeDoc.usedBy = `webuser_${user._id}`;
        codeDoc.usedAt = new Date();
        await codeDoc.save();

        // Add credits to basic tier
        user.credits_basic += codeDoc.credits;
        await user.save();

        // Log transaction
        await Transaction.create({
            telegramId: `webuser_${user._id}`,
            type: 'redeem',
            credits: codeDoc.credits,
            tier: 'basic',
            redeemCode: code.toUpperCase(),
            description: `Redeem code ${code.toUpperCase()} (+${codeDoc.credits} kredit basic)`,
        });

        // Log activity
        await ActivityLog.create({ userId: `webuser_${user._id}`, userEmail: user.email, action: 'redeem', details: { code: code.toUpperCase(), credits: codeDoc.credits, tier: 'basic' }, ip: req.ip }).catch(() => {});

        await notifyRedeemUsed(code.toUpperCase(), codeDoc.credits, 'web');

        res.json({
            success: true,
            creditsAdded: codeDoc.credits,
            newBalance: user.credits,
            message: `✅ +${codeDoc.credits} kredit basic berhasil ditambahkan!`,
        });
    } catch (err) {
        console.error('[Web Redeem] Error:', err.message);
        res.status(500).json({ error: 'Gagal redeem' });
    }
});

// =========================================================
// Web User: Request invite (uses tier-specific credit)
// =========================================================
app.post('/api/web/user/invite', authMiddleware, webUserMiddleware, async (req, res) => {
    try {
        const { email, tier = 'basic' } = req.body;
        if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email tidak valid' });
        if (!['basic', 'standard', 'premium'].includes(tier)) return res.status(400).json({ error: 'Tier tidak valid' });

        const user = await WebUser.findById(req.user.webUserId);
        if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });

        const creditField = `credits_${tier}`;
        if ((user[creditField] || 0) < 1) return res.status(400).json({ error: `Kredit ${tier} tidak cukup. Silakan top up dulu.` });

        const targetEmail = email.trim().toLowerCase();

        const account = await Account.findOne({ status: 'active', $expr: { $lt: ['$inviteCount', '$maxInvites'] } });
        if (!account) return res.status(503).json({ error: 'Semua akun sedang penuh. Coba lagi nanti.' });

        // Deduct tier-specific credit
        user[creditField] -= 1;
        user.totalInvites += 1;
        await user.save();

        const tierLabel = { basic: 'Basic', standard: 'Standard (14 hari garansi)', premium: 'Premium (30 hari garansi)' };

        // Log transaction
        await Transaction.create({
            telegramId: `webuser_${user._id}`,
            type: 'invite_used',
            credits: -1,
            tier,
            invitedEmail: targetEmail,
            description: `Invite ${targetEmail} [${tierLabel[tier]}]`,
        });

        // Log activity
        await ActivityLog.create({ userId: `webuser_${user._id}`, userEmail: user.email, action: 'invite', details: { email: targetEmail, tier }, ip: req.ip }).catch(() => {});

        // Enqueue with tier
        const { jobId, position } = await enqueue(`webuser_${user._id}`, targetEmail, tier);

        await notifyNewWebOrder(targetEmail, 'Dashboard');

        res.json({
            success: true,
            jobId,
            position,
            tier,
            newBalance: user.credits,
            message: position > 1
                ? `✅ Antrian ke-${position}. Email ${targetEmail} akan segera diinvite. (${tierLabel[tier]})`
                : `✅ Sedang diproses! Email ${targetEmail} akan segera diinvite. (${tierLabel[tier]})`,
        });
    } catch (err) {
        console.error('[Web Invite] Error:', err.message);
        res.status(500).json({ error: 'Gagal request invite' });
    }
});

// =========================================================
// Web User: Create QRIS payment (tier-based pricing)
// =========================================================
app.post('/api/web/user/pay', authMiddleware, webUserMiddleware, async (req, res) => {
    try {
        const { credits = 1, tier = 'basic' } = req.body;
        if (!['basic', 'standard', 'premium'].includes(tier)) return res.status(400).json({ error: 'Tier tidak valid' });

        const user = await WebUser.findById(req.user.webUserId);
        if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });

        const payment = await createPayment(`webuser_${user._id}`, credits, tier);

        // Log activity
        await ActivityLog.create({ userId: `webuser_${user._id}`, userEmail: user.email, action: 'buy_credit', details: { credits, tier, amount: payment.amountTotal }, ip: req.ip }).catch(() => {});

        res.json({
            success: true,
            transactionId: payment.transactionId,
            qrisContent: payment.qrisContent,
            amountTotal: payment.amountTotal,
            amountUnique: payment.amountUnique,
            expiresAt: payment.expiresAt,
            credits,
            tier,
        });
    } catch (err) {
        console.error('[Web Pay] Error:', err.response?.data || err.message);
        res.status(500).json({ error: 'Gagal membuat QRIS: ' + (err.response?.data?.message || err.message) });
    }
});

// =========================================================
// Web User: Guarantee claim
// =========================================================
app.post('/api/web/user/guarantee', authMiddleware, webUserMiddleware, async (req, res) => {
    try {
        const { jobId } = req.body;
        if (!jobId) return res.status(400).json({ error: 'Job ID diperlukan' });

        const user = await WebUser.findById(req.user.webUserId);
        if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });

        const job = await InviteJob.findOne({ _id: jobId, telegramId: `webuser_${user._id}`, status: 'done' });
        if (!job) return res.status(404).json({ error: 'Invite job tidak ditemukan' });
        if (job.tier === 'basic') return res.status(400).json({ error: 'Tier basic tidak memiliki garansi' });
        if (!job.guaranteeUntil || new Date() > job.guaranteeUntil) return res.status(400).json({ error: 'Masa garansi sudah berakhir' });
        if (job.guaranteeClaimed) return res.status(400).json({ error: 'Garansi sudah pernah di-claim' });

        // Mark as claimed — admin will approve and re-invite
        job.guaranteeClaimed = true;
        await job.save();

        // Log activity
        await ActivityLog.create({ userId: `webuser_${user._id}`, userEmail: user.email, action: 'guarantee_claim', details: { jobId, tier: job.tier, email: job.targetEmail }, ip: req.ip }).catch(() => {});

        res.json({ success: true, message: '✅ Claim garansi berhasil! Admin akan segera memproses re-invite kamu.' });
    } catch (err) {
        console.error('[Guarantee] Error:', err.message);
        res.status(500).json({ error: 'Gagal claim garansi' });
    }
});

// =========================================================
// PUBLIC: Check payment status
// =========================================================
app.get('/api/web/pay/status/:transactionId', async (req, res) => {
    const { transactionId } = req.params;
    const txn = await Transaction.findOne({ qrisTransactionId: transactionId, type: 'qris' });
    if (!txn) return res.status(404).json({ error: 'Transaksi tidak ditemukan' });

    if (txn.qrisStatus === 'pending') {
        const ageMs = Date.now() - new Date(txn.createdAt).getTime();
        if (ageMs > 15 * 60 * 1000) {
            txn.qrisStatus = 'expired';
            await txn.save();
        }
    }

    res.json({ status: txn.qrisStatus });
});

// =========================================================
// PUBLIC: Check invite job status
// =========================================================
app.get('/api/web/job/:jobId', async (req, res) => {
    const { jobId } = req.params;
    try {
        const job = await InviteJob.findById(jobId);
        if (!job) return res.status(404).json({ error: 'Job tidak ditemukan' });
        res.json({ status: job.status, result: job.result, email: job.targetEmail, tier: job.tier, guaranteeUntil: job.guaranteeUntil });
    } catch {
        res.status(400).json({ error: 'Invalid job ID' });
    }
});

// =========================================================
// Web User: List completed invites (for guarantee claims)
// =========================================================
app.get('/api/web/user/invites', authMiddleware, webUserMiddleware, async (req, res) => {
    try {
        const user = await WebUser.findById(req.user.webUserId);
        if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });

        const jobs = await InviteJob.find({
            telegramId: `webuser_${user._id}`,
            status: 'done',
        }).sort({ createdAt: -1 }).limit(50);

        res.json({ invites: jobs });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// =========================================================
// Web User: Claim guarantee
// =========================================================
app.post('/api/web/user/guarantee', authMiddleware, webUserMiddleware, async (req, res) => {
    try {
        const { jobId } = req.body;
        if (!jobId) return res.status(400).json({ error: 'Job ID diperlukan' });

        const user = await WebUser.findById(req.user.webUserId);
        if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });

        const job = await InviteJob.findOne({ _id: jobId, telegramId: `webuser_${user._id}`, status: 'done' });
        if (!job) return res.status(404).json({ error: 'Invite job tidak ditemukan' });
        if (job.tier === 'basic') return res.status(400).json({ error: 'Tier basic tidak memiliki garansi' });
        if (!job.guaranteeUntil || new Date() > job.guaranteeUntil) return res.status(400).json({ error: 'Masa garansi sudah berakhir' });
        if (job.guaranteeClaimed) return res.status(400).json({ error: 'Garansi sudah pernah di-claim' });

        // Mark as claimed — admin will approve and re-invite
        job.guaranteeClaimed = true;
        await job.save();

        // Log activity
        await ActivityLog.create({ userId: `webuser_${user._id}`, userEmail: user.email, action: 'guarantee_claim', details: { jobId, tier: job.tier, email: job.targetEmail }, ip: req.ip }).catch(() => {});

        res.json({ success: true, message: '✅ Claim garansi berhasil! Admin akan segera memproses re-invite kamu.' });
    } catch (err) {
        console.error('[Guarantee] Error:', err.message);
        res.status(500).json({ error: 'Gagal claim garansi' });
    }
});

// =========================================================
// PUBLIC: Server status
// =========================================================
app.get('/api/web/status', async (req, res) => {
    const seatAgg = await Account.aggregate([{ $match: { status: 'active', $expr: { $lt: ['$inviteCount', '$maxInvites'] } } }, { $group: { _id: null, totalSeats: { $sum: { $subtract: ['$maxInvites', '$inviteCount'] } } } }]);
    const availableSeats = seatAgg[0]?.totalSeats || 0;
    const pendingJobs = await InviteJob.countDocuments({ status: 'queued' });
    res.json({
        online: availableSeats > 0,
        availableSlots: availableSeats,
        queueLength: pendingJobs,
        pricePerInvite: TIER_PRICES.basic,
        tierPrices: TIER_PRICES,
    });
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

            // Check if this is a web user payment
            if (result.telegramId && result.telegramId.startsWith('webuser_')) {
                const webUserId = result.telegramId.replace('webuser_', '');
                const webUser = await WebUser.findById(webUserId);
                if (webUser) {
                    const tier = result.tier || 'basic';
                    const creditField = `credits_${tier}`;
                    webUser[creditField] = (webUser[creditField] || 0) + (result.creditsAdded || 1);
                    await webUser.save();
                    await ActivityLog.create({ userId: result.telegramId, userEmail: webUser.email, action: 'payment_received', details: { amount: result.amount || CREDIT_PRICE, credits: result.creditsAdded || 1, tier } }).catch(() => {});
                }
                await notifyPaymentReceived(result.amount || CREDIT_PRICE, result.creditsAdded || 1, 'web-dashboard');
            } else if (result.telegramId && result.telegramId.startsWith('web_')) {
                const email = result.telegramId.replace('web_', '');
                await enqueue(result.telegramId, email);
                await notifyPaymentReceived(result.amount || CREDIT_PRICE, result.creditsAdded || 1, 'web');
            } else {
                // Telegram user — notify via bot
                try {
                    const { bot } = require('./bot/userHandlers');
                    const tier = result.tier || 'basic';
                    const tierLabel = { basic: 'Basic', standard: 'Standard', premium: 'Premium' };
                    await bot.api.sendMessage(result.telegramId,
                        `✅ *Pembayaran Diterima!*\n\n💎 +${result.creditsAdded} kredit ${tierLabel[tier]} telah ditambahkan!\n💰 Saldo: *${result.newBalance} kredit*\n\nGunakan /gpti email@example.com untuk invite sekarang!`,
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
// Admin: All Activity Logs (filterable)
// =========================================================
app.get('/api/admin/activity-logs', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { page = 1, limit = 50, action, search } = req.query;
        const filter = {};
        if (action) filter.action = action;
        if (search) filter.$or = [
            { userEmail: { $regex: search, $options: 'i' } },
            { userId: { $regex: search, $options: 'i' } },
        ];
        const logs = await ActivityLog.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit));
        const total = await ActivityLog.countDocuments(filter);
        res.json({ logs, total, page: parseInt(page), limit: parseInt(limit) });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// =========================================================
// Admin: Guarantee claims management
// =========================================================
app.get('/api/admin/guarantee-claims', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const claims = await InviteJob.find({ guaranteeClaimed: true, status: 'done' })
            .sort({ processedAt: -1 }).limit(100);
        res.json({ claims });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/admin/guarantee-claims/:jobId/approve', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const job = await InviteJob.findById(req.params.jobId);
        if (!job) return res.status(404).json({ error: 'Job tidak ditemukan' });
        if (!job.guaranteeClaimed) return res.status(400).json({ error: 'Belum di-claim' });

        // Give back 1 credit of the same tier
        const userId = job.telegramId;
        const tier = job.tier || 'basic';
        const creditField = `credits_${tier}`;

        if (userId.startsWith('webuser_')) {
            const webUserId = userId.replace('webuser_', '');
            const user = await WebUser.findById(webUserId);
            if (user) {
                user[creditField] = (user[creditField] || 0) + 1;
                await user.save();
            }
        } else {
            await User.findOneAndUpdate({ telegramId: userId }, { $inc: { [creditField]: 1 } });
        }

        res.json({ success: true, message: `1 kredit ${tier} dikembalikan ke user` });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// =========================================================
// Admin: Auth login (username + password)
// =========================================================
app.post('/api/auth/login', authLimiter, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username dan password diperlukan' });

    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword) return res.status(500).json({ error: 'Admin password not configured' });

    if (username !== adminUsername || password !== adminPassword) {
        return res.status(403).json({ error: 'Username atau password salah' });
    }

    const token = jwt.sign({ isAdmin: true }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, isAdmin: true });
});

// =========================================================
// Admin endpoints (all require auth)
// =========================================================
app.get('/api/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const [totalUsers, totalWebUsers, totalInvites, todayInvites, accountStats, revenueData, pendingJobs] = await Promise.all([
        User.countDocuments(),
        WebUser.countDocuments(),
        Transaction.countDocuments({ type: 'invite_used' }),
        Transaction.countDocuments({ type: 'invite_used', createdAt: { $gte: todayStart } }),
        Account.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
        Transaction.aggregate([{ $match: { type: 'qris', qrisStatus: 'paid' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
        InviteJob.countDocuments({ status: 'queued' }),
    ]);
    const acMap = {};
    accountStats.forEach(s => acMap[s._id] = s.count);
    res.json({ totalUsers, totalWebUsers, totalInvites, todayInvites, totalRevenue: revenueData[0]?.total || 0, accounts: { active: acMap['active'] || 0, full: acMap['full'] || 0, error: acMap['error'] || 0 }, pendingJobs });
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
// Admin: Web Users management
// =========================================================
app.get('/api/admin/web-users', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { page = 1, limit = 20, search } = req.query;
        const query = search ? { email: { $regex: search, $options: 'i' } } : {};
        const users = await WebUser.find(query).select('-password').sort({ createdAt: -1 })
            .skip((page - 1) * limit).limit(parseInt(limit));
        const total = await WebUser.countDocuments(query);
        res.json({ users, total, page: parseInt(page), limit: parseInt(limit) });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/admin/web-users/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { credits = 1, prefix = 'FREE' } = req.body;
        const user = await WebUser.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
        if (user.freeCreditsGiven) return res.status(400).json({ error: 'User sudah pernah mendapat free credit' });

        // Generate redeem code
        const code = `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        await RedeemCode.create({
            code,
            credits,
            createdBy: req.user.telegramId,
            note: `Free credit for web user ${user.email}`,
        });

        // Send email with redeem code
        const emailSent = await sendRedeemCode(user.email, code, credits);

        // Mark user as approved
        user.isApproved = true;
        user.freeCreditsGiven = true;
        await user.save();

        // Log activity
        await ActivityLog.create({ userId: `webuser_${user._id}`, userEmail: user.email, action: 'approve', details: { code, credits } }).catch(() => { });

        res.json({
            success: true,
            code,
            emailSent,
            message: emailSent
                ? `✅ Kode ${code} dikirim ke ${user.email}`
                : `⚠️ Kode ${code} dibuat tapi email gagal terkirim. Kirim manual.`,
        });
    } catch (err) {
        console.error('[Approve] Error:', err.message);
        res.status(500).json({ error: 'Gagal approve user' });
    }
});

app.post('/api/admin/web-users/:id/block', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const user = await WebUser.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
        const wasBlocked = user.isBlocked;
        user.isBlocked = !user.isBlocked;
        await user.save();

        // Log activity
        await ActivityLog.create({ userId: `webuser_${user._id}`, userEmail: user.email, action: wasBlocked ? 'unblock' : 'block' }).catch(() => { });

        res.json({ success: true, isBlocked: user.isBlocked });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// =========================================================
// Admin: User Activity Logs
// =========================================================
app.get('/api/admin/web-users/:id/logs', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { limit = 20, page = 1 } = req.query;
        const user = await WebUser.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });

        const userId = `webuser_${user._id}`;
        const logs = await ActivityLog.find({ userId })
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit));
        const total = await ActivityLog.countDocuments({ userId });

        res.json({ logs, total, page: parseInt(page), limit: parseInt(limit) });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});


// =========================================================
// Admin: Settings (toggles)
// =========================================================
app.get('/api/admin/settings', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const freeCreditWeb = await Settings.getValue('free_credit_web', true);
        const freeCreditBot = await Settings.getValue('free_credit_bot', true);
        res.json({ free_credit_web: freeCreditWeb, free_credit_bot: freeCreditBot });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/admin/settings', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { key, value } = req.body;
        if (!key) return res.status(400).json({ error: 'Key required' });
        const allowedKeys = ['free_credit_web', 'free_credit_bot'];
        if (!allowedKeys.includes(key)) return res.status(400).json({ error: 'Invalid setting key' });
        await Settings.setValue(key, value, req.user.telegramId);
        res.json({ success: true, key, value });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
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
