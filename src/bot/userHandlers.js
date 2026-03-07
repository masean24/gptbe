require('dotenv').config();
const { Bot, InlineKeyboard } = require('grammy');
const User = require('../models/User');
const Account = require('../models/Account');
const RedeemCode = require('../models/RedeemCode');
const Transaction = require('../models/Transaction');
const InviteJob = require('../models/InviteJob');
const ActivityLog = require('../models/ActivityLog');
const Settings = require('../models/Settings');
const { enqueue } = require('../services/queueService');
const { createPayment, checkPayment, CREDIT_PRICE, TIER_PRICES, getTierPrice } = require('../services/qrisService');
const { loginAccount } = require('../services/playwrightService');
const { generateCodes } = require('./adminHandlers');

const bot = new Bot(process.env.BOT_TOKEN);

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
const REQUIRED_CHANNEL_ID = process.env.REQUIRED_CHANNEL_ID || '';
const REQUIRED_GROUP_ID = process.env.REQUIRED_GROUP_ID || '';
const CHANNEL_INVITE_LINK = process.env.CHANNEL_INVITE_LINK || '';
const GROUP_INVITE_LINK = process.env.GROUP_INVITE_LINK || '';

function isAdmin(ctx) {
    return ADMIN_IDS.includes(String(ctx.from.id));
}

// Helper: "Kembali ke Menu" inline keyboard
const menuKeyboard = new InlineKeyboard().text('📋 Kembali ke Menu', 'user_menu');

// =========================================================
// Force Join Check
// =========================================================
async function checkMembership(ctx, chatId) {
    if (!chatId) return true; // not configured = skip
    try {
        const member = await bot.api.getChatMember(chatId, ctx.from.id);
        return ['member', 'administrator', 'creator'].includes(member.status);
    } catch (err) {
        console.error(`[ForceJoin] Error checking ${chatId}:`, err.message);
        return false; // assume not joined on error
    }
}

async function forceJoinCheck(ctx) {
    if (isAdmin(ctx)) return true; // admin bypass

    const channelOk = await checkMembership(ctx, REQUIRED_CHANNEL_ID);
    const groupOk = await checkMembership(ctx, REQUIRED_GROUP_ID);

    if (channelOk && groupOk) return true;

    const name = ctx.from.first_name || 'Kawan';
    const text = `👋 *Hello ${name}*\n\nAnda harus bergabung di Channel/Grup saya terlebih dahulu untuk menggunakan bot ini.\n\nSilakan Join Channel & Group terlebih dahulu.`;

    const keyboard = new InlineKeyboard();

    if (GROUP_INVITE_LINK) keyboard.url('Join Group', GROUP_INVITE_LINK);
    if (CHANNEL_INVITE_LINK) keyboard.url('Join Channel', CHANNEL_INVITE_LINK);
    keyboard.row();
    if (CHANNEL_INVITE_LINK) keyboard.url('Join Channel', CHANNEL_INVITE_LINK);
    if (GROUP_INVITE_LINK) keyboard.url('Join Group', GROUP_INVITE_LINK);

    await ctx.reply(text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
    });
    return false;
}

// =========================================================
// Middleware: auto-register user on every message
// =========================================================
bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    await User.findOneAndUpdate(
        { telegramId: String(ctx.from.id) },
        {
            $setOnInsert: { telegramId: String(ctx.from.id) },
            $set: {
                username: ctx.from.username || null,
                firstName: ctx.from.first_name || null,
                lastActivityAt: new Date(),
            },
        },
        { upsert: true }
    );
    return next();
});

// =========================================================
// /start
// =========================================================
bot.command('start', async (ctx) => {
    const name = ctx.from.first_name || 'Kawan';
    const telegramId = String(ctx.from.id);

    // Check force join (but still show start message)
    const joined = await forceJoinCheck(ctx);
    if (!joined) return;

    // Free credit for first-time user
    try {
        const freeCreditEnabled = await Settings.getValue('free_credit_bot', true);
        if (freeCreditEnabled) {
            const user = await User.findOne({ telegramId });
            if (user && user.credits === 0 && user.totalInvites === 0) {
                // First time user, give 1 free credit
                user.credits += 1;
                await user.save();
                await Transaction.create({
                    telegramId,
                    type: 'admin_gift',
                    credits: 1,
                    description: 'Free credit — welcome bonus',
                });
                await ctx.reply(
                    `🎁 *Selamat! Kamu dapat 1 kredit gratis!*\n\n` +
                    `Langsung pakai dengan /invite email@example.com`,
                    { parse_mode: 'Markdown', reply_markup: menuKeyboard }
                );
            }
        }
    } catch (err) {
        console.error('[Start] Free credit error:', err.message);
    }

    const frontendUrl = process.env.FRONTEND_URL || '';
    const channelId = REQUIRED_CHANNEL_ID.startsWith('@') ? REQUIRED_CHANNEL_ID.replace('@', '') : '';

    const keyboard = new InlineKeyboard();
    if (frontendUrl) keyboard.url('🌐 Buka Website', frontendUrl).row();
    if (channelId) keyboard.url('📢 Join Channel', `https://t.me/${channelId}`).row();
    keyboard.text('📋 Menu', 'user_menu');

    await ctx.reply(
        `👋 Halo, *${name}!*\n\n` +
        `Selamat datang di *HubifyGPT Bot* 🤖\n` +
        `by *Hubify ID*\n\n` +
        `Bot ini membantu kamu mendapatkan akses ke *ChatGPT Plus* dengan cara mudah & otomatis — mulai dari *Rp5.000/invite!*\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📌 *Cara pakai:*\n` +
        `1️⃣ Beli kredit via QRIS atau tukar Redeem Code\n` +
        `2️⃣ Ketik /invite lalu masukkan email kamu\n` +
        `3️⃣ Tunggu konfirmasi invite masuk ke email!\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Ketik /menu untuk mulai 🚀`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
    );
});

// =========================================================
// /menu
// =========================================================
bot.command(['menu', 'help'], async (ctx) => {
    if (!(await forceJoinCheck(ctx))) return;

    const admin = isAdmin(ctx);
    let text =
        `📋 *MENU — HubifyGPT Bot*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🎯 *Invite ChatGPT Plus*\n` +
        `  /invite \`email@kamu.com\`\n\n` +
        `💰 *Kredit*\n` +
        `  /beli — Beli kredit via QRIS\n` +
        `  /redeem \`KODE\` — Tukar Redeem Code\n\n` +
        `📊 *Akun*\n` +
        `  /status — Saldo & info kamu\n` +
        `  /garansi — Cek & claim garansi\n` +
        `  /riwayat — Riwayat transaksi\n` +
        `━━━━━━━━━━━━━━━━━━━━`;

    if (admin) {
        text += `\n\n👑 *Admin*\n  /admin — Panel admin`;
    }

    await ctx.reply(text, { parse_mode: 'Markdown' });
});

// Handle Menu callback from /start inline button
bot.callbackQuery('user_menu', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await forceJoinCheck(ctx))) return;

    const admin = isAdmin(ctx);
    let text =
        `📋 *MENU — HubifyGPT Bot*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🎯 *Invite ChatGPT Plus*\n` +
        `  /invite \`email@kamu.com\`\n\n` +
        `💰 *Kredit*\n` +
        `  /beli — Beli kredit via QRIS\n` +
        `  /redeem \`KODE\` — Tukar Redeem Code\n\n` +
        `📊 *Akun*\n` +
        `  /status — Saldo & info kamu\n` +
        `  /garansi — Cek & claim garansi\n` +
        `  /riwayat — Riwayat transaksi\n` +
        `━━━━━━━━━━━━━━━━━━━━`;

    if (admin) {
        text += `\n\n👑 *Admin*\n  /admin — Panel admin`;
    }

    await ctx.reply(text, { parse_mode: 'Markdown' });
});

// =========================================================
// /status
// =========================================================
bot.command('status', async (ctx) => {
    if (!(await forceJoinCheck(ctx))) return;

    const user = await User.findOne({ telegramId: String(ctx.from.id) });
    if (!user) return ctx.reply('User tidak ditemukan. Coba /start dulu.');

    const accountStats = await Account.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);
    const activeAccounts = accountStats.find(s => s._id === 'active')?.count || 0;

    await ctx.reply(
        `📊 *STATUS KAMU*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `👤 *${user.firstName || user.username || 'User'}*` +
        `${user.username ? ` (@${user.username})` : ''}\n` +
        `🆔 ID: \`${user.telegramId}\`\n\n` +
        `💎 *Saldo Kredit*\n` +
        `  Basic: *${user.credits_basic || 0}*\n` +
        `  Standard: *${user.credits_standard || 0}* (14 hari garansi)\n` +
        `  Premium: *${user.credits_premium || 0}* (30 hari garansi)\n\n` +
        `📧 Total Invite: *${user.totalInvites}*\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🤖 Server: ${activeAccounts > 0 ? `✅ Online (${activeAccounts} akun aktif)` : '⚠️ Sedang maintenance'}\n\n` +
        `▸ /beli — tambah kredit\n` +
        `▸ /invite email@gmail.com — invite sekarang`,
        { parse_mode: 'Markdown', reply_markup: menuKeyboard }
    );
});

// =========================================================
// /invite - Request invite (also accepts /gpti for backward compat)
// =========================================================
bot.command(['invite', 'gpti'], async (ctx) => {
    if (!(await forceJoinCheck(ctx))) return;

    const args = ctx.message.text.split(' ');
    if (args.length < 2 || !args[1].includes('@')) {
        return ctx.reply(
            '❌ Format salah!\n\n✅ Contoh:\n`/invite john@gmail.com`',
            { parse_mode: 'Markdown' }
        );
    }

    const targetEmail = args[1].trim().toLowerCase();
    const telegramId = String(ctx.from.id);
    const user = await User.findOne({ telegramId });

    const totalCredits = (user?.credits_basic || 0) + (user?.credits_standard || 0) + (user?.credits_premium || 0);
    if (!user || totalCredits < 1) {
        return ctx.reply(
            `❌ *Saldo kredit tidak cukup!*\n\n` +
            `💰 Kredit kamu: *${totalCredits}*\n\n` +
            `Pilih cara topup:\n` +
            `• /beli — Bayar via QRIS\n` +
            `• /redeem KODE — Tukar Redeem Code`,
            { parse_mode: 'Markdown', reply_markup: menuKeyboard }
        );
    }

    const account = await Account.findOne({ status: 'active', $expr: { $lt: ['$inviteCount', '$maxInvites'] } });
    if (!account) {
        return ctx.reply('🚧 *Maintenance* — Semua akun sedang penuh. Coba lagi nanti.', { parse_mode: 'Markdown' });
    }

    // Check which tiers are available and let user pick
    const available = [];
    if ((user.credits_basic || 0) >= 1) available.push({ tier: 'basic', label: '⚡ Basic (tanpa garansi)', credits: user.credits_basic });
    if ((user.credits_standard || 0) >= 1) available.push({ tier: 'standard', label: '🛡️ Standard (14 hari garansi)', credits: user.credits_standard });
    if ((user.credits_premium || 0) >= 1) available.push({ tier: 'premium', label: '👑 Premium (30 hari garansi)', credits: user.credits_premium });

    if (available.length === 1) {
        // Only one tier available, use it directly
        const tier = available[0].tier;
        const processing = await ctx.reply('⏳ Memasukkan ke antrian...');
        const { jobId, position } = await enqueue(telegramId, targetEmail, tier);

        let msg = `✅ *Request diterima!* [${tier.toUpperCase()}]\n\n📧 Email: \`${targetEmail}\`\n`;
        if (position > 1) {
            msg += `⏳ Posisi antrian: *${position}*\n`;
            msg += `\nKamu akan mendapat notifikasi saat invite berhasil dikirim.`;
        } else {
            msg += `\n🔄 Sedang diproses sekarang...\nKamu akan mendapat notifikasi hasilnya.`;
        }
        await ctx.api.editMessageText(ctx.chat.id, processing.message_id, msg, { parse_mode: 'Markdown', reply_markup: menuKeyboard });
    } else {
        // Multiple tiers available, let user pick
        const keyboard = new InlineKeyboard();
        for (const t of available) {
            keyboard.text(`${t.label} (${t.credits}x)`, `invite_tier_${t.tier}_${targetEmail}`).row();
        }
        await ctx.reply(
            `📧 Invite ke \`${targetEmail}\`\n\n` +
            `Pilih tier kredit yang mau dipakai:`,
            { parse_mode: 'Markdown', reply_markup: keyboard }
        );
    }
});

// Handle invite tier selection callback
bot.callbackQuery(/^invite_tier_(basic|standard|premium)_(.+)$/, async (ctx) => {
    const tier = ctx.match[1];
    const targetEmail = ctx.match[2];
    const telegramId = String(ctx.from.id);

    await ctx.answerCallbackQuery();

    const user = await User.findOne({ telegramId });
    const creditField = `credits_${tier}`;
    if (!user || (user[creditField] || 0) < 1) {
        return ctx.reply(`❌ Kredit ${tier} tidak cukup.`);
    }

    const processing = await ctx.reply('⏳ Memasukkan ke antrian...');
    const { jobId, position } = await enqueue(telegramId, targetEmail, tier);

    let msg = `✅ *Request diterima!* [${tier.toUpperCase()}]\n\n📧 Email: \`${targetEmail}\`\n`;
    if (position > 1) {
        msg += `⏳ Posisi antrian: *${position}*\n`;
        msg += `\nKamu akan mendapat notifikasi saat invite berhasil dikirim.`;
    } else {
        msg += `\n🔄 Sedang diproses sekarang...\nKamu akan mendapat notifikasi hasilnya.`;
    }
    await ctx.api.editMessageText(ctx.chat.id, processing.message_id, msg, { parse_mode: 'Markdown', reply_markup: menuKeyboard });
});

// =========================================================
// /garansi - View & claim guarantees
// =========================================================
bot.command('garansi', async (ctx) => {
    if (!(await forceJoinCheck(ctx))) return;

    const telegramId = String(ctx.from.id);
    const jobs = await InviteJob.find({
        telegramId,
        status: 'done',
        tier: { $in: ['standard', 'premium'] },
        guaranteeUntil: { $ne: null },
    }).sort({ createdAt: -1 }).limit(10);

    if (jobs.length === 0) {
        return ctx.reply(
            `🛡️ *GARANSI*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
            `Kamu belum punya invite dengan garansi.\n\n` +
            `Garansi tersedia untuk tier *Standard* (14 hari) dan *Premium* (30 hari).\n` +
            `Gunakan /beli untuk membeli kredit bergaransi.`,
            { parse_mode: 'Markdown', reply_markup: menuKeyboard }
        );
    }

    const tierLabel = { standard: '🛡️ Standard', premium: '👑 Premium' };
    let text = `🛡️ *GARANSI INVITE*\n━━━━━━━━━━━━━━━━━━━━\n\n`;

    const keyboard = new InlineKeyboard();
    let claimable = 0;

    for (const job of jobs) {
        const hasGuarantee = job.guaranteeUntil && new Date(job.guaranteeUntil) > new Date();
        const expDate = job.guaranteeUntil ? new Date(job.guaranteeUntil).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }) : '-';
        const statusIcon = job.guaranteeClaimed ? '⏳' : (hasGuarantee ? '✅' : '❌');
        const statusText = job.guaranteeClaimed ? 'Menunggu Admin' : (hasGuarantee ? `s/d ${expDate}` : 'Expired');

        text += `${statusIcon} \`${job.targetEmail}\` — ${tierLabel[job.tier] || job.tier} (${statusText})\n`;

        if (hasGuarantee && !job.guaranteeClaimed) {
            keyboard.text(`🛡️ Claim: ${job.targetEmail}`, `claim_guarantee_${job._id}`).row();
            claimable++;
        }
    }

    text += `\n_Tekan tombol di bawah untuk claim garansi jika akses ChatGPT Plus hilang._`;

    keyboard.row().text('📋 Kembali ke Menu', 'user_menu');

    if (claimable > 0) {
        await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
    } else {
        await ctx.reply(text, { parse_mode: 'Markdown' });
    }
});

// Handle guarantee claim callback
bot.callbackQuery(/^claim_guarantee_(.+)$/, async (ctx) => {
    const jobId = ctx.match[1];
    const telegramId = String(ctx.from.id);

    await ctx.answerCallbackQuery();

    try {
        const job = await InviteJob.findOne({ _id: jobId, telegramId, status: 'done' });
        if (!job) return ctx.reply('❌ Invite job tidak ditemukan.');
        if (job.tier === 'basic') return ctx.reply('❌ Tier basic tidak memiliki garansi.');
        if (!job.guaranteeUntil || new Date() > job.guaranteeUntil) return ctx.reply('❌ Masa garansi sudah berakhir.');
        if (job.guaranteeClaimed) return ctx.reply('⚠️ Garansi sudah pernah di-claim.');

        job.guaranteeClaimed = true;
        await job.save();

        // Log activity
        await ActivityLog.create({ userId: telegramId, action: 'guarantee_claim', details: { jobId, tier: job.tier, email: job.targetEmail } }).catch(() => {});

        await ctx.reply(
            `✅ *Claim Garansi Berhasil!*\n\n` +
            `📧 Email: \`${job.targetEmail}\`\n` +
            `🛡️ Tier: ${job.tier}\n\n` +
            `Admin akan segera memproses re-invite kamu. Tunggu notifikasi ya!`,
            { parse_mode: 'Markdown', reply_markup: menuKeyboard }
        );
    } catch (err) {
        console.error('[Garansi] Error:', err.message);
        await ctx.reply('❌ Gagal claim garansi. Coba lagi nanti.');
    }
});

// =========================================================
// /beli - Buy credits via QRIS
// =========================================================
bot.command('beli', async (ctx) => {
    if (!(await forceJoinCheck(ctx))) return;

    const p = (tier) => TIER_PRICES[tier].toLocaleString('id-ID');
    const keyboard = new InlineKeyboard()
        .text(`⚡ Basic — Rp ${p('basic')} (tanpa garansi)`, 'buy_tier_basic')
        .row()
        .text(`🛡️ Standard — Rp ${p('standard')} (14 hari garansi)`, 'buy_tier_standard')
        .row()
        .text(`👑 Premium — Rp ${p('premium')} (30 hari garansi)`, 'buy_tier_premium');

    await ctx.reply(
        `💰 *BELI KREDIT*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
        `1 Kredit = 1x Invite ke ChatGPT Plus\n\n` +
        `📋 *Pilihan Paket:*\n\n` +
        `⚡ *Basic* — Rp ${p('basic')}\n` +
        `   Tanpa garansi\n\n` +
        `🛡️ *Standard* — Rp ${p('standard')}\n` +
        `   Garansi 14 hari (re-invite gratis jika revoke)\n\n` +
        `👑 *Premium* — Rp ${p('premium')}\n` +
        `   Garansi 30 hari (re-invite gratis jika revoke)\n\n` +
        `Pilih paket yang mau dibeli:`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
    );
});

// Handle back to /beli from quantity selection
bot.callbackQuery('back_to_beli', async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = (tier) => TIER_PRICES[tier].toLocaleString('id-ID');
    const keyboard = new InlineKeyboard()
        .text(`⚡ Basic — Rp ${p('basic')} (tanpa garansi)`, 'buy_tier_basic')
        .row()
        .text(`🛡️ Standard — Rp ${p('standard')} (14 hari garansi)`, 'buy_tier_standard')
        .row()
        .text(`👑 Premium — Rp ${p('premium')} (30 hari garansi)`, 'buy_tier_premium');

    await ctx.reply(
        `💰 *BELI KREDIT*\n━━━━━━━━━━━━━━━━━━━━\n\nPilih paket yang mau dibeli:`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
    );
});

// Handle tier selection for /beli
bot.callbackQuery(/^buy_tier_(basic|standard|premium)$/, async (ctx) => {
    const tier = ctx.match[1];
    await ctx.answerCallbackQuery();

    const price = TIER_PRICES[tier];
    const keyboard = new InlineKeyboard()
        .text(`1x — Rp ${price.toLocaleString('id-ID')}`, `buypay_${tier}_1`)
        .row()
        .text(`3x — Rp ${(price * 3).toLocaleString('id-ID')}`, `buypay_${tier}_3`)
        .row()
        .text(`5x — Rp ${(price * 5).toLocaleString('id-ID')}`, `buypay_${tier}_5`)
        .row()
        .text('⬅️ Kembali', 'back_to_beli');

    const tierLabel = { basic: 'Basic', standard: 'Standard (14 hari garansi)', premium: 'Premium (30 hari garansi)' };
    await ctx.reply(
        `💎 *Beli Kredit ${tierLabel[tier]}*\n\n` +
        `Harga: *Rp ${price.toLocaleString('id-ID')} / kredit*\n\n` +
        `Pilih jumlah kredit:`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
    );
});

// Handle buy payment callback
bot.callbackQuery(/^buypay_(basic|standard|premium)_(\d+)$/, async (ctx) => {
    const tier = ctx.match[1];
    const creditsToBuy = parseInt(ctx.match[2]);
    const telegramId = String(ctx.from.id);
    const chatId = ctx.chat.id;

    await ctx.answerCallbackQuery();
    const msg = await ctx.reply('⏳ Membuat QRIS payment...');

    try {
        const payment = await createPayment(telegramId, creditsToBuy, tier);
        const totalFormatted = payment.amountTotal.toLocaleString('id-ID');
        const expiresAt = new Date(payment.expiresAt);
        const expiresStr = expiresAt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
        const tierLabel = { basic: 'Basic', standard: 'Standard', premium: 'Premium' };

        const caption =
            `🧾 *QRIS PAYMENT*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
            `💎 Kredit: *${creditsToBuy}x ${tierLabel[tier]}*\n` +
            `💵 Total Bayar: *Rp ${totalFormatted}*\n` +
            `  _(Nominal unik: ${payment.amountUnique} — transfer tepat segini)_\n\n` +
            `⏰ Expired: *${expiresStr}*\n\n` +
            `📸 Scan QRIS di atas menggunakan aplikasi bank/e-wallet apapun.\n\n` +
            `_Kredit akan otomatis masuk setelah pembayaran terdeteksi._\n` +
            `ID: \`${payment.transactionId}\``;

        await ctx.api.deleteMessage(chatId, msg.message_id).catch(() => {});

        let qrisMessageId = null;
        try {
            const { InputFile } = require('grammy');
            const qr = require('qrcode');
            const qrBuffer = await qr.toBuffer(payment.qrisContent, { type: 'png', width: 400 });
            const qrisMsg = await ctx.replyWithPhoto(new InputFile(qrBuffer, 'qris.png'), {
                caption,
                parse_mode: 'Markdown',
            });
            qrisMessageId = qrisMsg.message_id;
        } catch (qrErr) {
            console.error('[Buy] QR generation failed, sending text fallback:', qrErr.message);
            const qrisMsg = await ctx.reply(
                caption + `\n\n📋 *QRIS String (copy ke app):*\n\`${payment.qrisContent}\``,
                { parse_mode: 'Markdown' }
            );
            qrisMessageId = qrisMsg.message_id;
        }

        startPaymentPoller(chatId, telegramId, payment.transactionId, creditsToBuy, qrisMessageId, tier);
    } catch (err) {
        console.error('[Buy] Error creating payment:', err.message);
        await ctx.api.editMessageText(chatId, msg.message_id, '❌ Gagal membuat QRIS. Coba lagi nanti.');
    }
});

// Remove old buy callbacks (no longer needed)

async function startPaymentPoller(chatId, telegramId, transactionId, credits, qrisMessageId, tier) {
    const maxAttempts = 90;
    let attempt = 0;

    const deleteQris = async () => {
        if (qrisMessageId) {
            await bot.api.deleteMessage(chatId, qrisMessageId).catch(() => { });
        }
    };

    const poll = async () => {
        if (attempt >= maxAttempts) {
            await deleteQris();
            await bot.api.sendMessage(telegramId, '⚠️ QRIS kamu sudah expired. Silakan /beli lagi untuk membuat QRIS baru.',
                { reply_markup: menuKeyboard }).catch(() => { });
            return;
        }
        attempt++;
        try {
            const txn = await checkPayment(transactionId);
            if (txn?.status === 'paid') {
                await deleteQris();
                const tierLabel = { basic: 'Basic', standard: 'Standard', premium: 'Premium' };
                await bot.api.sendMessage(telegramId,
                    `✅ *Pembayaran Diterima!*\n\n` +
                    `💎 ${credits} kredit *${tierLabel[tier] || ''}* berhasil ditambahkan ke akun kamu.\n\n` +
                    `Gunakan /invite email@example.com untuk invite sekarang!`,
                    { parse_mode: 'Markdown', reply_markup: menuKeyboard }
                );
                return;
            }
            if (txn?.status === 'expired') {
                await deleteQris();
                await bot.api.sendMessage(telegramId, '⚠️ QRIS kamu sudah expired. Silakan /beli lagi untuk membuat QRIS baru.',
                    { reply_markup: menuKeyboard });
                return;
            }
        } catch (_) { }

        setTimeout(poll, 10000);
    };

    // Send status message with refresh/cancel buttons
    const statusKeyboard = new InlineKeyboard()
        .text('🔄 Cek Status', `qris_check_${transactionId}`)
        .text('❌ Batalkan', `qris_cancel_${transactionId}`);
    await bot.api.sendMessage(telegramId,
        `⏳ *Menunggu pembayaran...*\n\nID: \`${transactionId}\`\n_Otomatis update, atau tekan tombol di bawah._`,
        { parse_mode: 'Markdown', reply_markup: statusKeyboard }
    ).catch(() => {});

    setTimeout(poll, 10000);
}

// QRIS manual check status callback
bot.callbackQuery(/^qris_check_(.+)$/, async (ctx) => {
    const transactionId = ctx.match[1];
    try {
        const txn = await checkPayment(transactionId);
        if (txn?.status === 'paid') {
            await ctx.answerCallbackQuery({ text: '✅ Sudah dibayar!' });
        } else if (txn?.status === 'expired') {
            await ctx.answerCallbackQuery({ text: '❌ QRIS expired' });
        } else {
            await ctx.answerCallbackQuery({ text: '⏳ Belum ada pembayaran terdeteksi' });
        }
    } catch {
        await ctx.answerCallbackQuery({ text: '⚠️ Gagal cek status' });
    }
});

// QRIS cancel callback
bot.callbackQuery(/^qris_cancel_(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Dibatalkan' });
    await ctx.reply('❌ Pembayaran dibatalkan. Gunakan /beli untuk membuat QRIS baru.',
        { reply_markup: menuKeyboard });
});

// =========================================================
// /redeem - Redeem a code
// =========================================================
bot.command('redeem', async (ctx) => {
    if (!(await forceJoinCheck(ctx))) return;

    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
        return ctx.reply('❌ Format: `/redeem KODE-ANDA`', { parse_mode: 'Markdown' });
    }

    const codeInput = args[1].trim().toUpperCase();
    const telegramId = String(ctx.from.id);

    const code = await RedeemCode.findOne({ code: codeInput, isUsed: false });
    if (!code) {
        return ctx.reply('❌ *Kode tidak valid atau sudah digunakan!*', { parse_mode: 'Markdown' });
    }

    if (code.expiresAt && new Date() > code.expiresAt) {
        return ctx.reply('❌ *Kode sudah kedaluwarsa.*', { parse_mode: 'Markdown' });
    }

    code.isUsed = true;
    code.usedBy = telegramId;
    code.usedAt = new Date();
    await code.save();

    const user = await User.findOneAndUpdate(
        { telegramId },
        { $inc: { credits: code.credits } },
        { new: true }
    );

    await Transaction.create({
        telegramId,
        type: 'redeem',
        credits: code.credits,
        redeemCode: codeInput,
        description: `Redeem code ${codeInput} (+${code.credits} kredit)`,
    });

    await ctx.reply(
        `🎉 *Redeem Berhasil!*\n\n` +
        `🎟️ Kode: \`${codeInput}\`\n` +
        `💎 +${code.credits} kredit ditambahkan!\n\n` +
        `💰 Saldo sekarang: *${user.credits} kredit*\n\n` +
        `Gunakan /invite email@example.com untuk mulai invite!`,
        { parse_mode: 'Markdown', reply_markup: menuKeyboard }
    );
});

// =========================================================
// /riwayat - Transaction history
// =========================================================
bot.command('riwayat', async (ctx) => {
    if (!(await forceJoinCheck(ctx))) return;

    const telegramId = String(ctx.from.id);
    const txns = await Transaction.find({ telegramId }).sort({ createdAt: -1 }).limit(10);

    if (!txns.length) return ctx.reply('📭 Belum ada riwayat transaksi.');

    const typeEmoji = { qris: '💳', redeem: '🎫', admin_gift: '🎁', invite_used: '📧' };
    let text = `📜 *RIWAYAT TRANSAKSI*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    for (const t of txns) {
        const sign = t.credits > 0 ? '+' : '';
        const date = t.createdAt.toLocaleDateString('id-ID');
        text += `${typeEmoji[t.type] || '•'} ${sign}${t.credits} kredit — ${t.description}\n_${date}_\n\n`;
    }

    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: menuKeyboard });
});

// =========================================================
// Export bot
// =========================================================
module.exports = { bot, isAdmin };
