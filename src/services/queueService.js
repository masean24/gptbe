const InviteJob = require('../models/InviteJob');
const Account = require('../models/Account');
const User = require('../models/User');
const WebUser = require('../models/WebUser');
const Transaction = require('../models/Transaction');
const RedeemCode = require('../models/RedeemCode');
const { inviteTeamMember } = require('./playwrightService');
const { notifyInviteFailed, notifyInviteSuccess } = require('./notifyService');
const { getTierGuaranteeDays } = require('./qrisService');

/**
 * If a web order used a redeem code and the invite failed,
 * un-redeem the code so the user can try again.
 */
function isWebOrder(telegramId) {
    return telegramId.startsWith('web_') || telegramId.startsWith('webuser_');
}

async function refundWebRedeem(telegramId) {
    if (!isWebOrder(telegramId)) return;

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
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_INVITES || '1');
let activeWorkers = 0;

/**
 * Add a new invite job to the queue
 * @param {string} telegramId
 * @param {string} targetEmail
 * @param {string} tier - 'basic', 'standard', or 'premium'
 */
async function enqueue(telegramId, targetEmail, tier = 'basic') {
    const guaranteeDays = getTierGuaranteeDays(tier);
    const job = await InviteJob.create({ telegramId, targetEmail, tier, guaranteeDays });
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
 * Main queue processor - concurrent workers
 */
async function processQueue() {
    if (isProcessing) return;
    isProcessing = true;

    try {
        while (true) {
            if (activeWorkers >= MAX_CONCURRENT) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                continue;
            }

            const job = await InviteJob.findOneAndUpdate(
                { status: 'queued' },
                { status: 'processing', processedAt: new Date() },
                { sort: { createdAt: 1 }, new: true }
            );
            if (!job) break;

            activeWorkers++;
            (async () => {
                try {
                    await processJob(job);
                } catch (err) {
                    console.error(`[Queue] Error processing job ${job._id}:`, err.message);
                    job.status = 'failed';
                    job.result = `Internal error: ${err.message}`;
                    await job.save();
                    await notifyInviteFailed(job.targetEmail, err.message);
                    await notifyUser(job.telegramId, job.targetEmail, err.message);
                    await refundWebRedeem(job.telegramId);
                } finally {
                    activeWorkers--;
                }
            })();

            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    } finally {
        while (activeWorkers > 0) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        isProcessing = false;
    }
}

async function processJob(job) {
    const { telegramId, targetEmail, tier } = job;
    const isWeb = isWebOrder(telegramId);

    // Check tier-specific credits
    const creditField = `credits_${tier || 'basic'}`;
    if (isWeb) {
        // Web user (webuser_ prefix)
        const webUserId = telegramId.replace('webuser_', '');
        const webUser = await WebUser.findOne({ _id: webUserId, [creditField]: { $gte: 1 } });
        if (!webUser) {
            job.status = 'failed';
            job.result = 'credits_insufficient';
            await job.save();
            return;
        }
    } else {
        // Telegram user
        const user = await User.findOne({ telegramId, [creditField]: { $gte: 1 } });
        if (!user) {
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
    console.log(`[Queue] Starting invite for ${targetEmail} using account ${account.email} (tier: ${tier})`);
    const result = await inviteTeamMember(account, targetEmail);
    console.log(`[Queue] Invite result for ${targetEmail}:`, JSON.stringify(result));

    if (result.success) {
        // Deduct tier-specific credit
        const creditField = `credits_${tier || 'basic'}`;
        if (isWeb) {
            // WebUser atomic deduction
            const webUserId = telegramId.replace('webuser_', '');
            const webUser = await WebUser.findOneAndUpdate(
                { _id: webUserId, [creditField]: { $gte: 1 } },
                { $inc: { [creditField]: -1, totalInvites: 1 } },
                { new: true }
            );
            if (!webUser) {
                job.status = 'failed';
                job.result = 'credits_insufficient';
                await job.save();
                return;
            }
        } else {
            // Telegram User atomic deduction
            const user = await User.findOneAndUpdate(
                { telegramId, [creditField]: { $gte: 1 } },
                { $inc: { [creditField]: -1, totalInvites: 1 }, $set: { lastActivityAt: new Date() } },
                { new: true }
            );
            if (!user) {
                job.status = 'failed';
                job.result = 'credits_insufficient';
                await job.save();
                await notifyInviteFailed(targetEmail, 'Kredit habis saat proses');
                await notifyUser(telegramId, targetEmail, 'Kredit habis saat proses invite');
                return;
            }
        }

        // Increment account invite count
        account.inviteCount += 1;
        account.lastUsed = new Date();
        if (account.inviteCount >= account.maxInvites) account.status = 'full';
        await account.save();

        // Set guarantee date
        const guaranteeDays = getTierGuaranteeDays(tier || 'basic');
        if (guaranteeDays > 0) {
            const guaranteeUntil = new Date();
            guaranteeUntil.setDate(guaranteeUntil.getDate() + guaranteeDays);
            job.guaranteeUntil = guaranteeUntil;
        }

        // Log transaction
        const tierLabel = { basic: 'Basic', standard: 'Standard', premium: 'Premium' };
        await Transaction.create({
            telegramId,
            type: 'invite_used',
            credits: -1,
            invitedEmail: targetEmail,
            tier: tier || 'basic',
            description: `Invite ${targetEmail} via akun ${account.email} [${tierLabel[tier] || 'Basic'}]`,
        });

        job.status = 'done';
        job.result = result.message;
        job.accountId = account._id.toString();
        await job.save();

        // Notify admin channel
        await notifyInviteSuccess(targetEmail, account.email);

        // Notify Telegram user via bot
        if (!isWeb) {
            try {
                const { bot } = require('../bot/userHandlers');
                const guaranteeMsg = guaranteeDays > 0
                    ? `\n🛡️ Garansi: ${guaranteeDays} hari (sampai ${job.guaranteeUntil.toLocaleDateString('id-ID')})`
                    : '\n⚠️ Tanpa garansi';
                await bot.api.sendMessage(telegramId,
                    `✅ *Invite Berhasil!*\n\n📧 \`${targetEmail}\` sudah diinvite ke ChatGPT Plus!${guaranteeMsg}`,
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
    if (isWebOrder(telegramId)) return;
    try {
        const { bot } = require('../bot/userHandlers');
        await bot.api.sendMessage(telegramId,
            `❌ Invite Gagal\n\n📧 Email: ${targetEmail}\n💬 Alasan: ${reason}\n\nKredit kamu tidak dikurangi. Silakan coba lagi atau hubungi admin.`
        );
    } catch (err) {
        console.error('[Queue] Failed to notify user:', err.message);
    }
}

module.exports = { enqueue, getQueuePosition, processQueue };
