const InviteJob = require('../models/InviteJob');
const Account = require('../models/Account');
const User = require('../models/User');
const WebUser = require('../models/WebUser');
const Transaction = require('../models/Transaction');
const RedeemCode = require('../models/RedeemCode');
const { inviteTeamMember } = require('./playwrightService');
const { getOrCreateNamespace, releaseAccount } = require('./vpnService');
const { notifyInviteFailed, notifyInviteSuccess, notifyAccountStatusChange } = require('./notifyService');
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
                    await notifyInviteFailed(job.targetEmail);
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

/**
 * Atomic account reservation with spillover logic.
 * - Filter: status active AND (inviteCount + reservedSlots) < maxInvites
 * - Sort: inviteCount DESC → fill-first (pakai akun paling penuh dulu)
 * - $inc reservedSlots secara atomic untuk prevent race condition
 */
async function getAccountForJob() {
    return Account.findOneAndUpdate(
        {
            status: 'active',
            $expr: { $lt: [{ $add: ['$inviteCount', '$reservedSlots'] }, '$maxInvites'] },
        },
        { $inc: { reservedSlots: 1 } },
        { sort: { inviteCount: -1 }, new: true }
    );
}

async function processJob(job) {
    const { telegramId, targetEmail, tier } = job;
    const isWeb = isWebOrder(telegramId);

    // Periksa kredit sebelum reservasi akun
    const creditField = `credits_${tier || 'basic'}`;
    if (isWeb) {
        const webUserId = telegramId.replace('webuser_', '');
        const webUser = await WebUser.findOne({ _id: webUserId, [creditField]: { $gte: 1 } });
        if (!webUser) {
            job.status = 'failed';
            job.result = 'credits_insufficient';
            await job.save();
            return;
        }
    } else {
        const user = await User.findOne({ telegramId, [creditField]: { $gte: 1 } });
        if (!user) {
            job.status = 'failed';
            job.result = 'credits_insufficient';
            await job.save();
            await notifyInviteFailed(targetEmail);
            await notifyUser(telegramId, targetEmail, 'Kredit tidak cukup');
            return;
        }
    }

    // Reservasi akun secara atomic — spillover otomatis ke akun lain
    const account = await getAccountForJob();
    if (!account) {
        job.status = 'failed';
        job.result = 'no_account_available';
        await job.save();
        await notifyInviteFailed(targetEmail);
        await notifyUser(telegramId, targetEmail, 'Tidak ada akun tersedia saat ini. Coba lagi nanti.');
        return;
    }

    // Assign VPN namespace (fallback ke proxy biasa kalau gagal)
    let nsName = null;
    try {
        nsName = await getOrCreateNamespace(account._id);
        if (nsName) console.log(`[Queue] VPN namespace: ${nsName} → akun ${account.email}`);
    } catch (vpnErr) {
        console.warn('[Queue] VPN setup gagal, fallback ke proxy:', vpnErr.message);
    }

    // Jalankan invite — reservedSlots SELALU di-decrement di finally, apapun yang terjadi
    let result;
    try {
        console.log(`[Queue] Starting invite for ${targetEmail} using account ${account.email} (tier: ${tier}${nsName ? ', vpn: ' + nsName : ''})`);
        result = await inviteTeamMember(account, targetEmail, nsName);
        console.log(`[Queue] Invite result for ${targetEmail}:`, JSON.stringify(result));
    } finally {
        await Account.findByIdAndUpdate(account._id, { $inc: { reservedSlots: -1 } }).catch(() => {});
    }

    if (result.success) {
        // Deduct kredit secara atomic
        if (isWeb) {
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
            const user = await User.findOneAndUpdate(
                { telegramId, [creditField]: { $gte: 1 } },
                { $inc: { [creditField]: -1, totalInvites: 1 }, $set: { lastActivityAt: new Date() } },
                { new: true }
            );
            if (!user) {
                job.status = 'failed';
                job.result = 'credits_insufficient';
                await job.save();
                await notifyInviteFailed(targetEmail);
                await notifyUser(telegramId, targetEmail, 'Kredit habis saat proses invite');
                return;
            }
        }

        // Increment inviteCount secara atomic (reservedSlots sudah di-decrement di finally)
        await Account.findByIdAndUpdate(
            account._id,
            { $inc: { inviteCount: 1 }, $set: { lastUsed: new Date() } }
        );
        const newInviteCount = account.inviteCount + 1;
        if (newInviteCount >= account.maxInvites) {
            await Account.findByIdAndUpdate(account._id, { status: 'full' });
            await notifyAccountStatusChange(account.email, 'active', 'full').catch(() => {});
            // Akun full → lepas VPN namespace
            try { await releaseAccount(account._id); } catch (_) {}
        }

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
            description: `Invite ${targetEmail} [${tierLabel[tier] || 'Basic'}]`,
        });

        job.status = 'done';
        job.result = result.message;
        job.accountId = account._id.toString();
        await job.save();

        await notifyInviteSuccess(targetEmail, account.email);

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
        await notifyInviteFailed(targetEmail);
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
            `❌ *Invite Gagal*\n\n` +
            `📧 Email: \`${targetEmail}\`\n\n` +
            `Kredit kamu *tidak dikurangi*. Silakan coba lagi nanti atau hubungi admin.`,
            { parse_mode: 'Markdown' }
        );
    } catch (err) {
        console.error('[Queue] Failed to notify user:', err.message);
    }
}

module.exports = { enqueue, getQueuePosition, processQueue };
