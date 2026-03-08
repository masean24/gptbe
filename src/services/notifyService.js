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

// =========================================================
// Privacy helpers
// =========================================================

/** ha****@gm***.com */
function maskEmail(email) {
    const [local, domain] = email.split('@');
    if (!domain) return '***';
    const [domName, ...tldParts] = domain.split('.');
    const tld = tldParts.join('.');
    const maskedLocal = local.slice(0, 2) + '****';
    const maskedDomain = domName.slice(0, 2) + '***';
    return `${maskedLocal}@${maskedDomain}.${tld}`;
}

/** FREE-8A9C5B72 → FREE-****5B72 */
function maskCode(code) {
    const parts = code.split('-');
    if (parts.length < 2) return code.slice(0, 4) + '****';
    const hash = parts[parts.length - 1];
    const masked = '****' + hash.slice(-4);
    return [...parts.slice(0, -1), masked].join('-');
}

/** Escape Markdown special characters for Telegram */
function escapeMarkdown(text) {
    if (!text) return '';
    return String(text)
        .replace(/[_*`\[\]()~>#+=|{}.!-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
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

const nowWIB = () => new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
});

const SEP = '─────────────────────────';

async function notifyInviteSuccess(email, accountEmail) {
    await notify(
        `✅ *INVITE BERHASIL*\n${SEP}\n` +
        `📧 \`${maskEmail(email)}\`\n` +
        `🤖 \`${maskEmail(accountEmail)}\`\n` +
        `🕐 _${nowWIB()} WIB_`
    );
}

async function notifyInviteFailed(email, reason) {
    const safeReason = escapeMarkdown(reason);
    await notify(
        `❌ *INVITE GAGAL*\n${SEP}\n` +
        `📧 \`${maskEmail(email)}\`\n` +
        `💬 ${safeReason}\n` +
        `🕐 _${nowWIB()} WIB_`
    );
}

async function notifyRedeemUsed(code, credits, source = 'web') {
    await notify(
        `🎫 *KODE REDEEMED*\n${SEP}\n` +
        `🔑 \`${maskCode(code)}\`\n` +
        `💎 +${credits} kredit  •  📱 ${source}\n` +
        `🕐 _${nowWIB()} WIB_`
    );
}

async function notifyPaymentReceived(amount, credits, source = 'web') {
    await notify(
        `💰 *PEMBAYARAN MASUK*\n${SEP}\n` +
        `💵 Rp ${amount.toLocaleString('id-ID')}\n` +
        `💎 +${credits} kredit  •  📱 ${source}\n` +
        `🕐 _${nowWIB()} WIB_`
    );
}

async function notifyNewWebOrder(email, method) {
    await notify(
        `🌐 *ORDER WEB BARU*\n${SEP}\n` +
        `📧 \`${maskEmail(email)}\`\n` +
        `💳 ${method}\n` +
        `🕐 _${nowWIB()} WIB_`
    );
}

async function notifyNewWebRegistration(email) {
    await notify(
        `👤 *USER WEB BARU DAFTAR*\n${SEP}\n` +
        `📧 \`${maskEmail(email)}\`\n` +
        `⏳ Menunggu approval admin\n` +
        `🕐 _${nowWIB()} WIB_`
    );
}

async function notifyGuaranteeClaim(email, tier, source = 'bot') {
    await notify(
        `🛡️ *GARANSI DI-CLAIM*\n${SEP}\n` +
        `📧 \`${maskEmail(email)}\`\n` +
        `🏷️ Tier: ${tier}  •  📱 ${source}\n` +
        `⏳ Menunggu approval admin\n` +
        `🕐 _${nowWIB()} WIB_`
    );
}

async function notifyAdminCredit(targetId, amount, tier, adminId) {
    await notify(
        `🎁 *ADMIN BERI KREDIT*\n${SEP}\n` +
        `👤 User: \`${targetId}\`\n` +
        `💎 +${amount} kredit ${tier}\n` +
        `👑 Admin: \`${adminId}\`\n` +
        `🕐 _${nowWIB()} WIB_`
    );
}

async function notifyAccountStatusChange(accountEmail, oldStatus, newStatus) {
    const icon = newStatus === 'full' ? '📦' : newStatus === 'error' ? '🔴' : '✅';
    await notify(
        `${icon} *STATUS AKUN BERUBAH*\n${SEP}\n` +
        `🤖 \`${maskEmail(accountEmail)}\`\n` +
        `📊 ${oldStatus} → *${newStatus}*\n` +
        `🕐 _${nowWIB()} WIB_`
    );
}

async function notifySessionExpired(accountEmail, reloginSuccess) {
    const icon = reloginSuccess ? '🔄' : '🔴';
    const status = reloginSuccess ? 'Re-login berhasil ✅' : 'Re-login GAGAL ❌';
    await notify(
        `${icon} *SESSION EXPIRED*\n${SEP}\n` +
        `🤖 \`${maskEmail(accountEmail)}\`\n` +
        `💬 ${status}\n` +
        `🕐 _${nowWIB()} WIB_`
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
    notifyGuaranteeClaim,
    notifyAdminCredit,
    notifyAccountStatusChange,
    notifySessionExpired,
};
