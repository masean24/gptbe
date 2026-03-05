require('dotenv').config();
const { Bot, InlineKeyboard } = require('grammy');
const User = require('../models/User');
const Account = require('../models/Account');
const RedeemCode = require('../models/RedeemCode');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const { enqueue } = require('../services/queueService');
const { createPayment, checkPayment, CREDIT_PRICE } = require('../services/qrisService');
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
                    `Langsung pakai dengan /gpti email@example.com`,
                    { parse_mode: 'Markdown' }
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
        `Bot ini membantu kamu mendapatkan akses ke *ChatGPT Plus* dengan cara mudah & otomatis — mulai dari *Rp10.000/invite!*\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📌 *Cara pakai:*\n` +
        `1️⃣ Beli kredit via QRIS atau tukar Redeem Code\n` +
        `2️⃣ Ketik /gpti lalu masukkan email kamu\n` +
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
        `  /gpti \`email@kamu.com\`\n\n` +
        `💰 *Kredit*\n` +
        `  /beli — Beli kredit via QRIS\n` +
        `  /redeem \`KODE\` — Tukar Redeem Code\n\n` +
        `📊 *Akun*\n` +
        `  /status — Saldo & info kamu\n` +
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
        `  /gpti \`email@kamu.com\`\n\n` +
        `💰 *Kredit*\n` +
        `  /beli — Beli kredit via QRIS\n` +
        `  /redeem \`KODE\` — Tukar Redeem Code\n\n` +
        `📊 *Akun*\n` +
        `  /status — Saldo & info kamu\n` +
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
        `💎 Saldo Kredit : *${user.credits}*\n` +
        `📧 Total Invite  : *${user.totalInvites}*\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🤖 Server: ${activeAccounts > 0 ? `✅ Online (${activeAccounts} akun aktif)` : '⚠️ Sedang maintenance'}\n\n` +
        `▸ /beli — tambah kredit\n` +
        `▸ /gpti email@gmail.com — invite sekarang`,
        { parse_mode: 'Markdown' }
    );
});

// =========================================================
// /gpti - Request invite
// =========================================================
bot.command('gpti', async (ctx) => {
    if (!(await forceJoinCheck(ctx))) return;

    const args = ctx.message.text.split(' ');
    if (args.length < 2 || !args[1].includes('@')) {
        return ctx.reply(
            '❌ Format salah!\n\n✅ Contoh:\n`/gpti john@gmail.com`',
            { parse_mode: 'Markdown' }
        );
    }

    const targetEmail = args[1].trim().toLowerCase();
    const telegramId = String(ctx.from.id);
    const user = await User.findOne({ telegramId });

    if (!user || user.credits < 1) {
        return ctx.reply(
            `❌ *Saldo kredit tidak cukup!*\n\n` +
            `💰 Kredit kamu: *${user?.credits || 0}*\n\n` +
            `Pilih cara topup:\n` +
            `• /beli — Bayar via QRIS\n` +
            `• /redeem KODE — Tukar Redeem Code`,
            { parse_mode: 'Markdown' }
        );
    }

    const account = await Account.findOne({ status: 'active', $expr: { $lt: ['$inviteCount', '$maxInvites'] } });
    if (!account) {
        return ctx.reply('🚧 *Maintenance* — Semua akun sedang penuh. Coba lagi nanti.', { parse_mode: 'Markdown' });
    }

    const processing = await ctx.reply('⏳ Memasukkan ke antrian...');
    const { jobId, position } = await enqueue(telegramId, targetEmail);

    let msg = `✅ *Request diterima!*\n\n📧 Email: \`${targetEmail}\`\n`;
    if (position > 1) {
        msg += `⏳ Posisi antrian: *${position}*\n`;
        msg += `\nKamu akan mendapat notifikasi saat invite berhasil dikirim.`;
    } else {
        msg += `\n🔄 Sedang diproses sekarang...\nKamu akan mendapat notifikasi hasilnya.`;
    }

    await ctx.api.editMessageText(ctx.chat.id, processing.message_id, msg, { parse_mode: 'Markdown' });
    bot.api.sendMessage(telegramId, `📨 Update invite ${targetEmail} akan dikirim ke sini.`).catch(() => { });
});

// =========================================================
// /beli - Buy credits via QRIS
// =========================================================
bot.command('beli', async (ctx) => {
    if (!(await forceJoinCheck(ctx))) return;

    const p = (n) => (n * CREDIT_PRICE).toLocaleString('id-ID');
    const keyboard = new InlineKeyboard()
        .text(`1 Kredit — Rp ${p(1)}`, 'buy_1')
        .row()
        .text(`3 Kredit — Rp ${p(3)}`, 'buy_3')
        .row()
        .text(`5 Kredit — Rp ${p(5)}`, 'buy_5')
        .row()
        .text(`10 Kredit — Rp ${p(10)}`, 'buy_10');

    await ctx.reply(
        `💰 *BELI KREDIT*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
        `1 Kredit = 1x Invite ke ChatGPT Plus\n` +
        `Harga: *Rp ${CREDIT_PRICE.toLocaleString('id-ID')} / kredit*\n\n` +
        `Pilih jumlah kredit yang ingin dibeli:`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
    );
});

// Handle buy callback
bot.callbackQuery(/^buy_(\d+)$/, async (ctx) => {
    const creditsToBuy = parseInt(ctx.match[1]);
    const telegramId = String(ctx.from.id);
    const chatId = ctx.chat.id;

    await ctx.answerCallbackQuery();
    const msg = await ctx.reply('⏳ Membuat QRIS payment...');

    try {
        const payment = await createPayment(telegramId, creditsToBuy);
        const totalFormatted = payment.amountTotal.toLocaleString('id-ID');
        const expiresAt = new Date(payment.expiresAt);
        const expiresStr = expiresAt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

        const caption =
            `🧾 *QRIS PAYMENT*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
            `💎 Kredit: *${creditsToBuy}x*\n` +
            `💵 Total Bayar: *Rp ${totalFormatted}*\n` +
            `  _(Nominal unik: ${payment.amountUnique} — transfer tepat segini)_\n\n` +
            `⏰ Expired: *${expiresStr}*\n\n` +
            `📸 Scan QRIS di atas menggunakan aplikasi bank/e-wallet apapun.\n\n` +
            `_Kredit akan otomatis masuk setelah pembayaran terdeteksi._\n` +
            `ID: \`${payment.transactionId}\``;

        await ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { });

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

        startPaymentPoller(chatId, telegramId, payment.transactionId, creditsToBuy, qrisMessageId);
    } catch (err) {
        console.error('[Buy] Error creating payment:', err.message);
        await ctx.api.editMessageText(chatId, msg.message_id, '❌ Gagal membuat QRIS. Coba lagi nanti.');
    }
});

async function startPaymentPoller(chatId, telegramId, transactionId, credits, qrisMessageId) {
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
            await bot.api.sendMessage(telegramId, '⚠️ QRIS kamu sudah expired. Silakan /beli lagi untuk membuat QRIS baru.').catch(() => { });
            return;
        }
        attempt++;
        try {
            const txn = await checkPayment(transactionId);
            if (txn?.status === 'paid') {
                await deleteQris();
                await bot.api.sendMessage(telegramId,
                    `✅ *Pembayaran Diterima!*\n\n` +
                    `💎 ${credits} kredit berhasil ditambahkan ke akun kamu.\n\n` +
                    `Gunakan /gpti email@example.com untuk invite sekarang!`,
                    { parse_mode: 'Markdown' }
                );
                return;
            }
            if (txn?.status === 'expired') {
                await deleteQris();
                await bot.api.sendMessage(telegramId, '⚠️ QRIS kamu sudah expired. Silakan /beli lagi untuk membuat QRIS baru.');
                return;
            }
        } catch (_) { }

        setTimeout(poll, 10000);
    };

    setTimeout(poll, 10000);
}

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
        `🎫 Kode: \`${codeInput}\`\n` +
        `💎 +${code.credits} kredit ditambahkan!\n\n` +
        `💰 Saldo sekarang: *${user.credits} kredit*\n\n` +
        `Gunakan /gpti email@example.com untuk mulai invite!`,
        { parse_mode: 'Markdown' }
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

    await ctx.reply(text, { parse_mode: 'Markdown' });
});

// =========================================================
// Export bot
// =========================================================
module.exports = { bot, isAdmin };
