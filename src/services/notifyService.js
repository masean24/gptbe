/**
 * Telegram Channel/Group Notification Service
 * Sends webhook notifications to admin channel for important events
 */

const LOG_CHAT_ID = process.env.LOG_CHAT_ID; // channel or group chat ID e.g. -1001234567890

let _bot = null;

function setBot(bot) {
    _bot = bot;
}

async function notify(text) {
    if (!_bot || !LOG_CHAT_ID) return;
    try {
        await _bot.api.sendMessage(LOG_CHAT_ID, text, { parse_mode: 'Markdown' });
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

module.exports = {
    setBot,
    notify,
    notifyInviteSuccess,
    notifyInviteFailed,
    notifyRedeemUsed,
    notifyPaymentReceived,
    notifyNewWebOrder,
};
