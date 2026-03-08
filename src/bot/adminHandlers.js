const { Bot, InlineKeyboard } = require('grammy');
const crypto = require('crypto');
const User = require('../models/User');
const Account = require('../models/Account');
const RedeemCode = require('../models/RedeemCode');
const Transaction = require('../models/Transaction');
const InviteJob = require('../models/InviteJob');
const Settings = require('../models/Settings');
const { loginAccount } = require('../services/playwrightService');
const { notifyAdminCredit } = require('../services/notifyService');

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);

function isAdmin(ctx) {
    return ADMIN_IDS.includes(String(ctx.from.id));
}

function generateCode(prefix = 'GPTI') {
    return `${prefix}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

// =========================================================
// Admin middleware guard
// =========================================================
function adminOnly(handler) {
    return async (ctx) => {
        if (!isAdmin(ctx)) {
            // Silently ignore non-admins — don't reveal admin features exist
            if (ctx.callbackQuery) await ctx.answerCallbackQuery();
            return;
        }
        return handler(ctx);
    };
}

// =========================================================
// /admin — Main admin panel menu
// =========================================================
async function showAdminMenu(ctx) {
    if (!isAdmin(ctx)) return ctx.reply('🚫 Akses ditolak.');

    const userCount = await User.countDocuments();
    const accountCount = await Account.countDocuments({ status: 'active' });
    const pendingJobs = await InviteJob.countDocuments({ status: 'queued' });
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayInvites = await Transaction.countDocuments({ type: 'invite_used', createdAt: { $gte: todayStart } });

    const freeCreditBot = await Settings.getValue('free_credit_bot', true);
    const freeCreditWeb = await Settings.getValue('free_credit_web', true);
    const keyboard = new InlineKeyboard()
        .text('👥 List Users', 'adm_listusers').text('🏦 Akun ChatGPT', 'adm_listaccounts').row()
        .text('🎟️ Generate Kode', 'adm_gencode').text('💎 Beri Kredit', 'adm_addcredit').row()
        .text('📢 Broadcast', 'adm_broadcast').text('📊 Statistik', 'adm_stats').row()
        .text('🔐 Login Akun', 'adm_loginaccount').text('🌐 Set Proxy', 'adm_setproxy').row()
        .text('🚫 Block User', 'adm_blockuser').text('✅ Unblock User', 'adm_unblockuser').row()
        .text(`🤖 Free Bot: ${freeCreditBot ? '✅' : '❌'}`, 'toggle_free_credit_bot')
        .text(`🌐 Free Web: ${freeCreditWeb ? '✅' : '❌'}`, 'toggle_free_credit_web');

    // Add web admin panel button if FRONTEND_URL is set
    const frontendUrl = process.env.FRONTEND_URL || '';
    if (frontendUrl) {
        keyboard.row().url('🖥️ Buka Admin Panel', `${frontendUrl}/Maseans24`);
    }

    const text =
        `👑 *ADMIN PANEL*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
        `👥 Total User: ${userCount}\n` +
        `🤖 Akun Aktif: ${accountCount}\n` +
        `⏳ Queue Pending: ${pendingJobs}\n` +
        `📧 Invite Hari Ini: ${todayInvites}\n`;

    if (ctx.callbackQuery) {
        await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
        await ctx.answerCallbackQuery();
    } else {
        await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
    }
}

// =========================================================
// Generate Codes
// =========================================================
async function generateCodes(adminId, count, creditsEach, prefix = 'GPTI', note = '') {
    const codes = [];
    for (let i = 0; i < count; i++) {
        const code = generateCode(prefix);
        await RedeemCode.create({ code, credits: creditsEach, createdBy: adminId, note });
        codes.push(code);
    }
    return codes;
}

// =========================================================
// Register all admin handlers on a bot instance
// =========================================================
function registerAdminHandlers(bot) {

    // Global error handler — prevent bot crash on handler errors
    bot.catch((err) => {
        console.error('[Bot] Error caught:', err.message || err);
    });

    bot.command('admin', adminOnly(showAdminMenu));

    // ---- STATS ----
    bot.callbackQuery('adm_stats', adminOnly(async (ctx) => {
        await ctx.answerCallbackQuery();
        const totalUsers = await User.countDocuments();
        const totalInvites = await Transaction.countDocuments({ type: 'invite_used' });
        const totalRevenue = await Transaction.aggregate([
            { $match: { type: 'qris', qrisStatus: 'paid' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const accountStats = await Account.aggregate([
            { $group: { _id: '$status', count: { $sum: 1 } } }
        ]);

        const acMap = {};
        accountStats.forEach(s => acMap[s._id] = s.count);
        const revenue = totalRevenue[0]?.total || 0;

        const keyboard = new InlineKeyboard().text('⬅️ Kembali', 'adm_back');
        await ctx.editMessageText(
            `📊 *STATISTIK LENGKAP*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
            `👥 Total User: ${totalUsers}\n` +
            `📧 Total Invite: ${totalInvites}\n` +
            `💰 Total Revenue: Rp ${revenue.toLocaleString('id-ID')}\n\n` +
            `🤖 Akun Active: ${acMap['active'] || 0}\n` +
            `🔴 Akun Full: ${acMap['full'] || 0}\n` +
            `❌ Akun Error: ${acMap['error'] || 0}`,
            { parse_mode: 'Markdown', reply_markup: keyboard }
        );
    }));

    // ---- LIST USERS ----
    bot.callbackQuery('adm_listusers', adminOnly(async (ctx) => {
        await ctx.answerCallbackQuery();
        const users = await User.find().sort({ credits: -1 }).limit(20);
        let text = `👥 *DAFTAR USER* (top 20)\n━━━━━━━━━━━━━━━━━━━━\n\n`;
        users.forEach((u, i) => {
            text += `${i + 1}. @${u.username || '-'} | ID: \`${u.telegramId}\` | 💎 ${u.credits} kredit\n`;
        });

        const keyboard = new InlineKeyboard().text('⬅️ Kembali', 'adm_back');
        await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
    }));

    // ---- LIST ACCOUNTS ----
    bot.callbackQuery('adm_listaccounts', adminOnly(async (ctx) => {
        await ctx.answerCallbackQuery();
        const accounts = await Account.find().sort({ createdAt: -1 });
        if (!accounts.length) {
            const kb = new InlineKeyboard().text('➕ Tambah Akun', 'adm_addaccount').row().text('⬅️ Kembali', 'adm_back');
            return ctx.editMessageText('📭 Belum ada akun ChatGPT.', { reply_markup: kb });
        }

        let text = `🏦 *AKUN CHATGPT*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
        accounts.forEach((acc, i) => {
            const statusEmoji = acc.status === 'active' ? '✅' : acc.status === 'full' ? '🔴' : '❌';
            text += `${i + 1}. ${statusEmoji} \`${acc.email}\`\n`;
            text += `   📨 ${acc.inviteCount}/${acc.maxInvites} | 🔐Session: ${acc.hasSession ? '✅' : '❌'}\n`;
            text += `   🆔 \`${acc._id}\`\n\n`;
        });

        text += `\n_Klik tombol di bawah untuk mengelola akun:_`;

        const keyboard = new InlineKeyboard()
            .text('➕ Tambah Akun', 'adm_addaccount').row()
            .text('🗑️ Hapus Akun', 'adm_delaccount_choose').row()
            .text('⬅️ Kembali', 'adm_back');
        await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
    }));

    // ---- CHOOSE ACCOUNT TO DELETE ----
    bot.callbackQuery('adm_delaccount_choose', adminOnly(async (ctx) => {
        await ctx.answerCallbackQuery();
        const accounts = await Account.find().sort({ createdAt: -1 });
        if (!accounts.length) {
            return ctx.editMessageText('📭 Tidak ada akun untuk dihapus.', {
                reply_markup: new InlineKeyboard().text('⬅️ Kembali', 'adm_listaccounts'),
            });
        }

        let text = `🗑️ *HAPUS AKUN*\n━━━━━━━━━━━━━━━━━━━━\n\nPilih akun yang ingin dihapus:`;
        const keyboard = new InlineKeyboard();
        accounts.forEach((acc) => {
            const statusEmoji = acc.status === 'active' ? '✅' : acc.status === 'full' ? '🔴' : '❌';
            keyboard.text(`${statusEmoji} ${acc.email}`, `adm_del_${acc._id}`).row();
        });
        keyboard.text('⬅️ Kembali', 'adm_listaccounts');

        await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
    }));

    // ---- CONFIRM DELETE ----
    bot.callbackQuery(/^adm_del_(.+)$/, adminOnly(async (ctx) => {
        await ctx.answerCallbackQuery();
        const accountId = ctx.match[1];

        // If it's a confirmation
        if (accountId.startsWith('confirm_')) {
            const realId = accountId.replace('confirm_', '');
            const account = await Account.findByIdAndDelete(realId);
            if (!account) return ctx.editMessageText('❌ Akun tidak ditemukan!');
            await ctx.editMessageText(
                `✅ Akun \`${account.email}\` berhasil dihapus!`,
                { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().text('⬅️ Kembali ke List', 'adm_listaccounts') }
            );
            return;
        }

        const account = await Account.findById(accountId);
        if (!account) return ctx.editMessageText('❌ Akun tidak ditemukan!');

        const keyboard = new InlineKeyboard()
            .text(`✅ Ya, Hapus ${account.email}`, `adm_del_confirm_${accountId}`).row()
            .text('❌ Batal', 'adm_listaccounts');

        await ctx.editMessageText(
            `⚠️ *Yakin hapus akun ini?*\n\n📧 \`${account.email}\`\n📨 Invite: ${account.inviteCount}/${account.maxInvites}\n🔐 Session: ${account.hasSession ? '✅' : '❌'}`,
            { parse_mode: 'Markdown', reply_markup: keyboard }
        );
    }));

    // ---- ADD ACCOUNT (start flow) ----
    bot.callbackQuery('adm_addaccount', adminOnly(async (ctx) => {
        await ctx.answerCallbackQuery();
        const text = '➕ *TAMBAH AKUN CHATGPT*\n\nKirim dalam format:\n`/addaccount email password 2fa_secret`\n\n`2fa_secret` boleh dikosongkan jika tidak ada 2FA.';
        const opts = { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().text('⬅️ Kembali', 'adm_back') };
        try {
            await ctx.editMessageText(text, opts);
        } catch (err) {
            console.error('[adm_addaccount] editMessageText failed:', err.message);
            await ctx.reply(text, opts);
        }
    }));

    // ---- /addaccount command ----
    bot.command('addaccount', adminOnly(async (ctx) => {
        const parts = ctx.message.text.split(' ');
        if (parts.length < 3) {
            return ctx.reply('❌ Format: `/addaccount email password [2fa_secret]`', { parse_mode: 'Markdown' });
        }
        const [, email, password, twoFASecret = ''] = parts;
        const existing = await Account.findOne({ email });
        if (existing) return ctx.reply('❌ Email sudah terdaftar!');

        const account = await Account.create({ email, password, twoFASecret });
        const keyboard = new InlineKeyboard().text(`🔑 Login Akun ini`, `adm_login_${account._id}`);
        await ctx.reply(
            `✅ *Akun berhasil ditambahkan!*\n📧 Email: \`${email}\`\n🆔 ID: \`${account._id}\`\n\n⚠️ Jangan lupa login akun ini agar bisa digunakan.`,
            { parse_mode: 'Markdown', reply_markup: keyboard }
        );
    }));

    // ---- LOGIN ACCOUNT ----
    bot.command('loginaccount', adminOnly(async (ctx) => {
        const parts = ctx.message.text.split(' ');
        const accountId = parts[1];
        if (!accountId) return ctx.reply('❌ Format: `/loginaccount <account_id>`', { parse_mode: 'Markdown' });

        const account = await Account.findById(accountId);
        if (!account) return ctx.reply('❌ Akun tidak ditemukan!');

        const msg = await ctx.reply(`🔄 Login untuk \`${account.email}\`...\nMohon tunggu (bisa sampai 1 menit)...`, { parse_mode: 'Markdown' });

        const result = await loginAccount(account);
        if (result.success) {
            account.hasSession = true;
            account.sessionData = result.sessionData;
            await account.save();
            await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `✅ Login \`${account.email}\` berhasil! Session tersimpan.`, { parse_mode: 'Markdown' });
        } else {
            await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Login gagal: ${result.message}`);
        }
    }));

    // Callback login button from addaccount
    bot.callbackQuery(/^adm_login_(.+)$/, adminOnly(async (ctx) => {
        await ctx.answerCallbackQuery('Memulai login...');
        const accountId = ctx.match[1];
        const account = await Account.findById(accountId);
        if (!account) return ctx.reply('❌ Akun tidak ditemukan!');

        const msg = await ctx.reply(`🔄 Login \`${account.email}\`... Mohon tunggu.`, { parse_mode: 'Markdown' });
        const result = await loginAccount(account);
        if (result.success) {
            account.hasSession = true;
            account.sessionData = result.sessionData;
            await account.save();
            await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `✅ Login berhasil! Session tersimpan.`);
        } else {
            await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Login gagal: ${result.message}`);
        }
    }));

    // ---- DELETEACCOUNT ----
    bot.command('deleteaccount', adminOnly(async (ctx) => {
        const parts = ctx.message.text.split(' ');
        const accountId = parts[1];
        if (!accountId) return ctx.reply('❌ Format: `/deleteaccount <account_id>`', { parse_mode: 'Markdown' });

        const account = await Account.findByIdAndDelete(accountId);
        if (!account) return ctx.reply('❌ Akun tidak ditemukan!');
        await ctx.reply(`✅ Akun \`${account.email}\` berhasil dihapus!`, { parse_mode: 'Markdown' });
    }));

    // ---- RESET ACCOUNT ----
    bot.command('resetaccount', adminOnly(async (ctx) => {
        const parts = ctx.message.text.split(' ');
        const accountId = parts[1];
        if (!accountId) return ctx.reply('❌ Format: `/resetaccount <account_id>`', { parse_mode: 'Markdown' });

        const account = await Account.findByIdAndUpdate(accountId, { inviteCount: 0, status: 'active' }, { new: true });
        if (!account) return ctx.reply('❌ Akun tidak ditemukan!');
        await ctx.reply(`✅ Akun \`${account.email}\` invite count direset!`, { parse_mode: 'Markdown' });
    }));

    // ---- GENERATE CODES ----
    bot.callbackQuery('adm_gencode', adminOnly(async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(
            `🎫 *GENERATE REDEEM CODE*\n\nFormat perintah:\n\`/gencode <jumlah> <kredit_per_kode> [prefix]\`\n\nContoh:\n\`/gencode 5 1\` — 5 kode masing-masing 1 kredit\n\`/gencode 10 3 VIP\` — 10 kode VIP masing-masing 3 kredit`,
            { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().text('⬅️ Kembali', 'adm_back') }
        );
    }));

    bot.command('gencode', adminOnly(async (ctx) => {
        const parts = ctx.message.text.split(' ');
        const count = parseInt(parts[1]);
        const credits = parseInt(parts[2]);
        const prefix = parts[3] || 'GPTI';

        if (isNaN(count) || isNaN(credits) || count < 1 || credits < 1 || count > 100) {
            return ctx.reply('❌ Format: `/gencode <jumlah> <kredit> [prefix]`\n\nMaks 100 kode sekali generate.', { parse_mode: 'Markdown' });
        }

        const msg = await ctx.reply(`⏳ Generating ${count} kode...`);
        const codes = await generateCodes(String(ctx.from.id), count, credits, prefix);

        const webUrl = process.env.FRONTEND_URL || '';
        const webPass = process.env.WEB_ACCESS_PASSWORD || '';
        const codeText = codes.join('\n');
        let reply = `✅ *${count} Kode Berhasil Dibuat!*\n💎 Nilai: ${credits} kredit/kode\n\n\`\`\`\n${codeText}\n\`\`\``;
        reply += `\n\n📱 Redeem via bot: \`/redeem KODE\``;
        if (webUrl) {
            reply += `\n🌐 Redeem via web: ${webUrl}`;
            if (webPass) reply += `\n🔑 Password web: \`${webPass}\``;
        }
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, reply, { parse_mode: 'Markdown' });
    }));

    // ---- ADD CREDIT ----
    bot.callbackQuery('adm_addcredit', adminOnly(async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(
            `💎 *BERI KREDIT KE USER*\n\nFormat perintah:\n\`/addcredit <telegram_id> <jumlah> [tier]\`\n\nTier: basic (default), standard, premium\n\nContoh:\n\`/addcredit 123456789 5\` → Basic\n\`/addcredit 123456789 3 standard\`\n\`/addcredit 123456789 2 premium\``,
            { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().text('⬅️ Kembali', 'adm_back') }
        );
    }));

    bot.command('addcredit', adminOnly(async (ctx) => {
        const parts = ctx.message.text.split(' ');
        const targetId = parts[1];
        const amount = parseInt(parts[2]);
        const tier = ['basic', 'standard', 'premium'].includes(parts[3]) ? parts[3] : 'basic';
        const creditField = `credits_${tier}`;

        if (!targetId || isNaN(amount) || amount < 1) {
            return ctx.reply('❌ Format: `/addcredit <telegram_id> <jumlah> [basic|standard|premium]`', { parse_mode: 'Markdown' });
        }

        const user = await User.findOneAndUpdate(
            { telegramId: targetId },
            { $inc: { [creditField]: amount } },
            { new: true }
        );
        if (!user) return ctx.reply('❌ User tidak ditemukan!');

        const totalCredits = (user.credits_basic || 0) + (user.credits_standard || 0) + (user.credits_premium || 0);
        const tierLabel = { basic: 'Basic', standard: 'Standard', premium: 'Premium' };

        await Transaction.create({
            telegramId: targetId,
            type: 'admin_gift',
            credits: amount,
            description: `Admin gift ${amount} kredit ${tierLabel[tier]} dari ${ctx.from.id}`,
        });

        await ctx.reply(
            `✅ Berhasil menambahkan *${amount} kredit ${tierLabel[tier]}* ke user \`${targetId}\`\n` +
            `Saldo baru: Basic *${user.credits_basic || 0}* | Standard *${user.credits_standard || 0}* | Premium *${user.credits_premium || 0}*\n` +
            `Total: *${totalCredits} kredit*`,
            { parse_mode: 'Markdown' }
        );

        // Notify user
        await bot.api.sendMessage(targetId,
            `🎁 *Kamu mendapat ${amount} kredit ${tierLabel[tier]}!*\n\nAdmin telah menambahkan kredit ke akunmu.\n💰 Saldo: *${totalCredits} kredit*`,
            { parse_mode: 'Markdown' }
        ).catch(() => { });

        // Log to admin channel
        await notifyAdminCredit(targetId, amount, tierLabel[tier], String(ctx.from.id)).catch(() => {});
    }));

    // ---- SET PROXY PER ACCOUNT ----
    bot.command('setproxy', adminOnly(async (ctx) => {
        const parts = ctx.message.text.split(' ');
        const accountEmail = parts[1];
        const proxyUrl = parts[2] || '';

        if (!accountEmail) {
            return ctx.reply(
                '❌ Format:\n' +
                '`/setproxy account@email.com http://user:pass@host:port`\n' +
                '`/setproxy account@email.com` _(kosongkan untuk hapus proxy)_',
                { parse_mode: 'Markdown' }
            );
        }

        const account = await Account.findOneAndUpdate(
            { email: accountEmail },
            { assignedProxy: proxyUrl },
            { new: true }
        );
        if (!account) return ctx.reply('❌ Akun tidak ditemukan!');

        if (proxyUrl) {
            await ctx.reply(`✅ Proxy untuk \`${accountEmail}\` diset ke:\n\`${proxyUrl}\``, { parse_mode: 'Markdown' });
        } else {
            await ctx.reply(`✅ Proxy untuk \`${accountEmail}\` dihapus. Akan pakai proxy pool / direct.`, { parse_mode: 'Markdown' });
        }
    }));

    // ---- LOGIN ACCOUNT (button) ----
    bot.callbackQuery('adm_loginaccount', adminOnly(async (ctx) => {
        await ctx.answerCallbackQuery();
        const accounts = await Account.find().sort({ createdAt: -1 });
        if (!accounts.length) {
            return ctx.editMessageText('📭 Belum ada akun.', { reply_markup: new InlineKeyboard().text('⬅️ Kembali', 'adm_back') });
        }
        const keyboard = new InlineKeyboard();
        accounts.forEach(acc => {
            const icon = acc.hasSession ? '✅' : '❌';
            keyboard.text(`${icon} ${acc.email}`, `adm_dologin_${acc._id}`).row();
        });
        keyboard.text('⬅️ Kembali', 'adm_back');
        await ctx.editMessageText('🔐 *LOGIN AKUN*\n\nPilih akun untuk login:', { parse_mode: 'Markdown', reply_markup: keyboard });
    }));

    bot.callbackQuery(/^adm_dologin_(.+)$/, adminOnly(async (ctx) => {
        const accountId = ctx.match[1];
        await ctx.answerCallbackQuery();
        const account = await Account.findById(accountId);
        if (!account) return ctx.editMessageText('❌ Akun tidak ditemukan.', { reply_markup: new InlineKeyboard().text('⬅️ Kembali', 'adm_back') });

        await ctx.editMessageText(`⏳ Login ke \`${account.email}\`... (bisa 1-2 menit)`, { parse_mode: 'Markdown' });
        const result = await loginAccount(account);
        if (result.success) {
            account.sessionData = result.sessionData;
            account.hasSession = true;
            account.status = 'active';
            await account.save();
            await ctx.editMessageText(`✅ Login berhasil! \`${account.email}\` siap dipakai.`, { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().text('⬅️ Kembali', 'adm_back') });
        } else {
            await ctx.editMessageText(`❌ Login gagal: ${result.message}`, { reply_markup: new InlineKeyboard().text('🔄 Coba Lagi', `adm_dologin_${accountId}`).row().text('⬅️ Kembali', 'adm_back') });
        }
    }));

    // ---- SET PROXY (button) ----
    bot.callbackQuery('adm_setproxy', adminOnly(async (ctx) => {
        await ctx.answerCallbackQuery();
        const accounts = await Account.find().sort({ createdAt: -1 });
        let text = '🌐 *SET PROXY PER AKUN*\n\n';
        accounts.forEach(acc => {
            text += `• \`${acc.email}\`\n  Proxy: ${acc.assignedProxy || '_(tidak ada — pakai pool/direct)_'}\n\n`;
        });
        text += `Format:\n\`/setproxy email@akun.com http://proxy:port\`\n\`/setproxy email@akun.com\` _(hapus proxy)_`;
        await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().text('⬅️ Kembali', 'adm_back') });
    }));

    // ---- BLOCK/UNBLOCK USER (button) ----
    bot.callbackQuery('adm_blockuser', adminOnly(async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(
            '🚫 *BLOCK USER*\n\nFormat:\n`/blockuser <telegram_id>`',
            { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().text('⬅️ Kembali', 'adm_back') }
        );
    }));

    bot.callbackQuery('adm_unblockuser', adminOnly(async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(
            '✅ *UNBLOCK USER*\n\nFormat:\n`/unblockuser <telegram_id>`',
            { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().text('⬅️ Kembali', 'adm_back') }
        );
    }));

    // ---- BLOCK USER ----
    bot.command('blockuser', adminOnly(async (ctx) => {
        const telegramId = ctx.message.text.split(' ')[1];
        if (!telegramId) return ctx.reply('❌ Format: `/blockuser <telegram_id>`', { parse_mode: 'Markdown' });
        const user = await User.findOneAndUpdate({ telegramId }, { isBlocked: true });
        if (!user) return ctx.reply('❌ User tidak ditemukan!');
        await ctx.reply(`🚫 User \`${telegramId}\` diblokir.`, { parse_mode: 'Markdown' });
    }));

    bot.command('unblockuser', adminOnly(async (ctx) => {
        const telegramId = ctx.message.text.split(' ')[1];
        if (!telegramId) return ctx.reply('❌ Format: `/unblockuser <telegram_id>`', { parse_mode: 'Markdown' });
        const user = await User.findOneAndUpdate({ telegramId }, { isBlocked: false });
        if (!user) return ctx.reply('❌ User tidak ditemukan!');
        await ctx.reply(`✅ User \`${telegramId}\` sudah di-unblock.`, { parse_mode: 'Markdown' });
    }));

    // ---- BROADCAST (/bc) ----
    bot.callbackQuery('adm_broadcast', adminOnly(async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(
            `📢 *BROADCAST*\n\nKirim pesan ke semua user bot.\nFormat:\n\`/bc Pesan kamu di sini\`\n\nSupport *bold*, _italic_, \`monospace\`.`,
            { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().text('⬅️ Kembali', 'adm_back') }
        );
    }));

    bot.command('bc', adminOnly(async (ctx) => {
        const text = ctx.message.text.replace(/^\/bc\s*/, '').trim();
        if (!text) return ctx.reply('❌ Pesan tidak boleh kosong.\nFormat: `/bc <pesan>`', { parse_mode: 'Markdown' });

        const users = await User.find({ isBlocked: false }).select('telegramId');
        const msg = await ctx.reply(`📢 Mengirim ke ${users.length} user...`);

        let sent = 0, failed = 0;
        for (const user of users) {
            try {
                await bot.api.sendMessage(user.telegramId, `📢 *PENGUMUMAN*\n\n${text}`, { parse_mode: 'Markdown' });
                sent++;
                await new Promise(r => setTimeout(r, 50)); // Rate limit protection
            } catch (_) {
                failed++;
            }
        }

        await ctx.api.editMessageText(ctx.chat.id, msg.message_id,
            `✅ *Broadcast Selesai!*\n\n📤 Terkirim: ${sent}\n❌ Gagal: ${failed}`,
            { parse_mode: 'Markdown' }
        );
    }));

    // ---- TOGGLE FREE CREDIT ----
    bot.callbackQuery('toggle_free_credit_bot', adminOnly(async (ctx) => {
        const current = await Settings.getValue('free_credit_bot', true);
        await Settings.setValue('free_credit_bot', !current, String(ctx.from.id));
        await ctx.answerCallbackQuery(`Free Credit Bot: ${!current ? 'ON' : 'OFF'}`);
        await showAdminMenu(ctx);
    }));

    bot.callbackQuery('toggle_free_credit_web', adminOnly(async (ctx) => {
        const current = await Settings.getValue('free_credit_web', true);
        await Settings.setValue('free_credit_web', !current, String(ctx.from.id));
        await ctx.answerCallbackQuery(`Free Credit Web: ${!current ? 'ON' : 'OFF'}`);
        await showAdminMenu(ctx);
    }));

    // ---- BACK BUTTON ----
    bot.callbackQuery('adm_back', adminOnly(showAdminMenu));

}

module.exports = { registerAdminHandlers, generateCodes, isAdmin };
