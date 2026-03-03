const InviteJob = require('../models/InviteJob');
const Account = require('../models/Account');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const RedeemCode = require('../models/RedeemCode');
const { inviteTeamMember } = require('./playwrightService');
const { notifyInviteFailed, notifyInviteSuccess } = require('./notifyService');

/**
 * If a web order used a redeem code and the invite failed,
 * un-redeem the code so the user can try again.
 */
async function refundWebRedeem(telegramId) {
    if (!telegramId.startsWith('web_')) return;

    const redeemTxn = await Transaction.findOne({
        telegramId,
        type: 'redeem',
    }).sort({ createdAt: -1 });

    if (!redeemTxn || !redeemTxn.redeemCode) return;

    const code = await RedeemCode.findOne({ code: redeemTxn.redeemCode });
    if (code && code.isUsed) {
        code.isUsed = false;
        code.usedBy = null;
        code.usedAt = null;
        await code.save();
        console.log(`[Queue] Refunded redeem code ${code.code} for failed web invite`);
    }

    await redeemTxn.deleteOne();
}

let isProcessing = false;

/**
 * Add a new invite job to the queue
 */
async function enqueue(telegramId, targetEmail) {
    const job = await InviteJob.create({ telegramId, targetEmail });
    const position = await InviteJob.countDocuments({ status: 'queued', createdAt: { $lt: job.createdAt } }) + 1;
    processQueue(); // fire and forget
    return { jobId: job._id.toString(), position };
}

/**
 * Get current queue position for a job
 */
async function getQueuePosition(jobId) {
    const job = await InviteJob.findById(jobId);
    if (!job) return null;
    if (job.status !== 'queued') return { status: job.status };
    const pos = await InviteJob.countDocuments({ status: 'queued', createdAt: { $lt: job.createdAt } }) + 1;
    return { status: 'queued', position: pos };
}

/**
 * Main queue processor - single concurrency (safe for VPS 1/1)
 */
async function processQueue() {
    if (isProcessing) return;
    isProcessing = true;

    try {
        while (true) {
            const job = await InviteJob.findOneAndUpdate(
                { status: 'queued' },
                { status: 'processing', processedAt: new Date() },
                { sort: { createdAt: 1 }, new: true }
            );
            if (!job) break;

            try {
                await processJob(job);
            } catch (err) {
                console.error(`[Queue] Error processing job ${job._id}:`, err.message);
                console.error(`[Queue] Full error:`, err);
                job.status = 'failed';
                job.result = `Internal error: ${err.message}`;
                await job.save();
                await notifyInviteFailed(job.targetEmail, err.message);
                await notifyUser(job.telegramId, job.targetEmail, err.message);
                await refundWebRedeem(job.telegramId);
            }
        }
    } finally {
        isProcessing = false;
    }
}

async function processJob(job) {
    const { telegramId, targetEmail } = job;
    const isWebOrder = telegramId.startsWith('web_');

    // For Telegram users, check credits
    if (!isWebOrder) {
        const user = await User.findOne({ telegramId });
        if (!user || user.credits < 1) {
            job.status = 'failed';
            job.result = 'credits_insufficient';
            await job.save();
            await notifyInviteFailed(targetEmail, 'Kredit tidak cukup');
            await notifyUser(telegramId, targetEmail, 'Kredit tidak cukup');
            return;
        }
    }

    // Get available ChatGPT account
    const account = await Account.findOne({ status: 'active', $expr: { $lt: ['$inviteCount', '$maxInvites'] } });
    if (!account) {
        job.status = 'failed';
        job.result = 'no_account_available';
        await job.save();
        await notifyInviteFailed(targetEmail, 'Tidak ada akun tersedia');
        await notifyUser(telegramId, targetEmail, 'Tidak ada akun tersedia saat ini. Coba lagi nanti.');
        return;
    }

    // Do the invite via Playwright
    console.log(`[Queue] Starting invite for ${targetEmail} using account ${account.email}`);
    const result = await inviteTeamMember(account, targetEmail);
    console.log(`[Queue] Invite result for ${targetEmail}:`, JSON.stringify(result));

    if (result.success) {
        // Deduct credit for Telegram users only (web orders already "paid")
        if (!isWebOrder) {
            const user = await User.findOne({ telegramId });
            user.credits -= 1;
            user.totalInvites += 1;
            user.lastActivityAt = new Date();
            await user.save();
        }

        // Increment account invite count
        account.inviteCount += 1;
        account.lastUsed = new Date();
        if (account.inviteCount >= account.maxInvites) account.status = 'full';
        await account.save();

        // Log transaction
        await Transaction.create({
            telegramId,
            type: 'invite_used',
            credits: -1,
            invitedEmail: targetEmail,
            description: `Invite ${targetEmail} via akun ${account.email}`,
        });

        job.status = 'done';
        job.result = result.message;
        job.accountId = account._id.toString();
        await job.save();

        // Notify admin channel
        await notifyInviteSuccess(targetEmail, account.email);

        // Notify Telegram user via bot
        if (!isWebOrder) {
            try {
                const { bot } = require('../bot/userHandlers');
                await bot.api.sendMessage(telegramId,
                    `✅ *Invite Berhasil!*\n\n📧 \`${targetEmail}\` sudah diinvite ke ChatGPT Team!`,
                    { parse_mode: 'Markdown' }
                );
            } catch (_) { }
        }
    } else {
        job.status = 'failed';
        job.result = result.message;
        await job.save();
        await notifyInviteFailed(targetEmail, result.message);
        await notifyUser(telegramId, targetEmail, result.message);
        await refundWebRedeem(telegramId);
    }
}

/**
 * Notify the user via Telegram when invite fails
 */
async function notifyUser(telegramId, targetEmail, reason) {
    if (telegramId.startsWith('web_')) return;
    try {
        const { bot } = require('../bot/userHandlers');
        // Don't use Markdown here — error messages may contain special chars
        await bot.api.sendMessage(telegramId,
            `❌ Invite Gagal\n\n📧 Email: ${targetEmail}\n💬 Alasan: ${reason}\n\nKredit kamu tidak dikurangi. Silakan coba lagi atau hubungi admin.`
        );
    } catch (err) {
        console.error('[Queue] Failed to notify user:', err.message);
    }
}

module.exports = { enqueue, getQueuePosition, processQueue };
