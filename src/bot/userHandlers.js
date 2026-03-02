require('dotenv').config();
const { Bot, InlineKeyboard } = require('grammy');
const User = require('../models/User');
const Account = require('../models/Account');
const RedeemCode = require('../models/RedeemCode');
const Transaction = require('../models/Transaction');
const { enqueue } = require('../services/queueService');
const { createPayment, checkPayment, CREDIT_PRICE } = require('../services/qrisService');
const { loginAccount } = require('../services/playwrightService');
const { generateCodes } = require('./adminHandlers');

const bot = new Bot(process.env.BOT_TOKEN);

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);

function isAdmin(ctx) {
    return ADMIN_IDS.includes(String(ctx.from.id));
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
    await ctx.reply(
        `👋 Halo, *${name}!*\n\n` +
        `Selamat datang di *GPT Invite Bot* 🤖\n\n` +
        `Bot ini membantu kamu mendapatkan akses ke *ChatGPT Team* dengan cara mudah dan otomatis.\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📌 *Cara pakai:*\n` +
        `1. Beli kredit via QRIS atau tukar Redeem Code\n` +
        `2. Ketik /gpti lalu email kamu\n` +
        `3. Tunggu konfirmasi invite masuk ke email!\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `📋 Ketik /menu untuk melihat semua perintah.`,
        { parse_mode: 'Markdown' }
    );
});

// =========================================================
// /menu
// =========================================================
bot.command(['menu', 'help'], async (ctx) => {
    const admin = isAdmin(ctx);
    let text = `📋 *MENU UTAMA*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    text += `🎯 *Invite*\n`;
    text += `• /gpti \`email@example.com\` — Invite email ke ChatGPT Team\n\n`;
    text += `💰 *Kredit*\n`;
    text += `• /beli — Beli kredit via QRIS\n`;
    text += `• /redeem \`KODE\` — Tukar Redeem Code\n\n`;
    text += `📊 *Info*\n`;
    text += `• /status — Cek saldo & informasi kamu\n`;
    text += `• /riwayat — Riwayat transaksi\n\n`;

    if (admin) {
        text += `\n👑 *Admin Panel*\n`;
        text += `• /admin — Buka panel admin\n`;
    }

    await ctx.reply(text, { parse_mode: 'Markdown' });
});

// =========================================================
// /status
// =========================================================
bot.command('status', async (ctx) => {
    const user = await User.findOne({ telegramId: String(ctx.from.id) });
    if (!user) return ctx.reply('User tidak ditemukan. Coba /start dulu.');

    const accountStats = await Account.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);
    const activeAccounts = accountStats.find(s => s._id === 'active')?.count || 0;

    await ctx.reply(
        `📊 *STATUS KAMU*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
        `👤 Username: @${user.username || '-'}\n` +
        `🆔 Telegram ID: \`${user.telegramId}\`\n\n` +
        `💎 *Saldo Kredit: ${user.credits}*\n` +
        `📧 Total Invite: ${user.totalInvites}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🤖 Server: ${activeAccounts > 0 ? `✅ Online (${activeAccounts} akun aktif)` : '⚠️ Maintenance'}\n\n` +
        `💡 /beli untuk tambah kredit\n` +
        `💡 /gpti email@gmail.com untuk invite`,
        { parse_mode: 'Markdown' }
    );
});

// =========================================================
// /gpti - Request invite
// =========================================================
bot.command('gpti', async (ctx) => {
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
    const keyboard = new InlineKeyboard()
        .text('1 Kredit — Rp 5.000', 'buy_1')
        .row()
        .text('3 Kredit — Rp 15.000', 'buy_3')
        .row()
        .text('5 Kredit — Rp 25.000', 'buy_5')
        .row()
        .text('10 Kredit — Rp 50.000', 'buy_10');

    await ctx.reply(
        `💰 *BELI KREDIT*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
        `1 Kredit = 1x Invite ke ChatGPT Team\n` +
        `Harga: *Rp ${CREDIT_PRICE.toLocaleString('id-ID')} / kredit*\n\n` +
        `Pilih jumlah kredit yang ingin dibeli:`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
    );
});

// Handle buy callback
bot.callbackQuery(/^buy_(\d+)$/, async (ctx) => {
    const creditsToBuy = parseInt(ctx.match[1]);
    const telegramId = String(ctx.from.id);

    await ctx.answerCallbackQuery();
    const msg = await ctx.reply('⏳ Membuat QRIS payment...');

    try {
        const payment = await createPayment(telegramId, creditsToBuy);
        const totalFormatted = payment.amountTotal.toLocaleString('id-ID');
        const expiresAt = new Date(payment.expiresAt);
        const expiresStr = expiresAt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

        // Generate QR code image from QRIS content
        const qr = require('qrcode');
        const qrBuffer = await qr.toBuffer(payment.qrisContent, { type: 'png', width: 400 });

        await ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => { });
        await ctx.replyWithPhoto({ source: qrBuffer }, {
            caption:
                `🧾 *QRIS PAYMENT*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
                `💎 Kredit: *${creditsToBuy}x*\n` +
                `💵 Total Bayar: *Rp ${totalFormatted}*\n` +
                `  _(Nominal unik: ${payment.amountUnique} — transfer tepat segini)_\n\n` +
                `⏰ Expired: *${expiresStr}*\n\n` +
                `📸 Scan QRIS di atas menggunakan aplikasi bank/e-wallet apapun.\n\n` +
                `_Kredit akan otomatis masuk setelah pembayaran terdeteksi._\n` +
                `ID: \`${payment.transactionId}\``,
            parse_mode: 'Markdown',
        });

        // Poll for payment for 15 minutes
        startPaymentPoller(ctx, telegramId, payment.transactionId, creditsToBuy);
    } catch (err) {
        console.error('[Buy] Error creating payment:', err.message);
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, '❌ Gagal membuat QRIS. Coba lagi nanti.');
    }
});

async function startPaymentPoller(ctx, telegramId, transactionId, credits) {
    const maxAttempts = 90; // 15 minutes (10s interval)
    let attempt = 0;

    const poll = async () => {
        if (attempt >= maxAttempts) return;
        attempt++;
        try {
            const txn = await checkPayment(transactionId);
            if (txn?.status === 'paid') {
                // Credits are added via webhook; send notification
                await bot.api.sendMessage(telegramId,
                    `✅ *Pembayaran Diterima!*\n\n` +
                    `💎 ${credits} kredit berhasil ditambahkan ke akun kamu.\n\n` +
                    `Gunakan /gpti email@example.com untuk invite sekarang!`,
                    { parse_mode: 'Markdown' }
                );
                return;
            }
            if (txn?.status === 'expired') {
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

    // Check expiry
    if (code.expiresAt && new Date() > code.expiresAt) {
        return ctx.reply('❌ *Kode sudah kedaluwarsa.*', { parse_mode: 'Markdown' });
    }

    // Mark code as used
    code.isUsed = true;
    code.usedBy = telegramId;
    code.usedAt = new Date();
    await code.save();

    // Add credits
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
// Export bot (main.js will call bot.start())
// =========================================================
module.exports = { bot, isAdmin };
