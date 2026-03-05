/**
 * Telegram Channel/Group Notification Service
 * Supports forum group topics via LOG_TOPIC_ID
 */

const LOG_CHAT_ID = process.env.LOG_CHAT_ID;
const LOG_TOPIC_ID = process.env.LOG_TOPIC_ID ? parseInt(process.env.LOG_TOPIC_ID) : null;

let _bot = null;

function setBot(bot) {
    _bot = bot;
}

async function notify(text) {
    if (!_bot || !LOG_CHAT_ID) return;
    try {
        const opts = { parse_mode: 'Markdown' };
        if (LOG_TOPIC_ID) opts.message_thread_id = LOG_TOPIC_ID;
        await _bot.api.sendMessage(LOG_CHAT_ID, text, opts);
    } catch (err) {
        console.error('[Notify] Failed to send to channel:', err.message);
    }
}

// =========================================================
// Event-specific notifications
// =========================================================

async function notifyInviteSuccess(email, accountEmail) {
    await notify(
        `✅ *INVITE BERHASIL*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
        `📧 Email: \`${email}\`\n` +
        `🤖 Akun: \`${accountEmail}\`\n` +
        `🕐 ${new Date().toLocaleString('id-ID')}`
    );
}

async function notifyInviteFailed(email, reason) {
    await notify(
        `❌ *INVITE GAGAL*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
        `📧 Email: \`${email}\`\n` +
        `💬 Reason: ${reason}\n` +
        `🕐 ${new Date().toLocaleString('id-ID')}`
    );
}

async function notifyRedeemUsed(code, credits, source = 'web') {
    await notify(
        `🎫 *KODE REDEEMED*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🔑 Kode: \`${code}\`\n` +
        `💎 Kredit: +${credits}\n` +
        `📱 Via: ${source}\n` +
        `🕐 ${new Date().toLocaleString('id-ID')}`
    );
}

async function notifyPaymentReceived(amount, credits, source = 'web') {
    await notify(
        `💰 *PEMBAYARAN MASUK*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
        `💵 Rp ${amount.toLocaleString('id-ID')}\n` +
        `💎 Kredit: +${credits}\n` +
        `📱 Via: ${source}\n` +
        `🕐 ${new Date().toLocaleString('id-ID')}`
    );
}

async function notifyNewWebOrder(email, method) {
    await notify(
        `🌐 *ORDER WEB BARU*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
        `📧 Email: \`${email}\`\n` +
        `💳 Metode: ${method}\n` +
        `🕐 ${new Date().toLocaleString('id-ID')}`
    );
}

async function notifyNewWebRegistration(email) {
    await notify(
        `👤 *USER WEB BARU DAFTAR*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
        `📧 Email: \`${email}\`\n` +
        `⏳ Menunggu approval admin\n` +
        `🕐 ${new Date().toLocaleString('id-ID')}`
    );
}

module.exports = {
    setBot,
    notify,
    notifyInviteSuccess,
    notifyInviteFailed,
    notifyRedeemUsed,
    notifyPaymentReceived,
    notifyNewWebOrder,
    notifyNewWebRegistration,
};
