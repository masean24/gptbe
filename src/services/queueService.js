const InviteJob = require('../models/InviteJob');
const Account = require('../models/Account');
const User = require('../models/User');
const WebUser = require('../models/WebUser');
const Transaction = require('../models/Transaction');
const { inviteTeamMember } = require('./playwrightService');
const { getOrCreateNamespace, releaseAccount } = require('./vpnService');
const { notifyInviteFailed, notifyInviteSuccess, notifyAccountStatusChange } = require('./notifyService');
const { getTierGuaranteeDays } = require('./qrisService');

function isWebOrder(telegramId) {
    return telegramId.startsWith('web_') || telegramId.startsWith('webuser_');
}

function getCreditField(tier = 'basic') {
    return `credits_${tier}`;
}

async function reserveUserCredit(telegramId, tier = 'basic') {
    const creditField = getCreditField(tier);

    if (isWebOrder(telegramId)) {
        const webUserId = telegramId.replace('webuser_', '');
        return WebUser.findOneAndUpdate(
            { _id: webUserId, [creditField]: { $gte: 1 } },
            { $inc: { [creditField]: -1 } },
            { new: true }
        );
    }

    return User.findOneAndUpdate(
        { telegramId, [creditField]: { $gte: 1 } },
        { $inc: { [creditField]: -1 } },
        { new: true }
    );
}

async function refundUserCredit(telegramId, tier = 'basic') {
    const creditField = getCreditField(tier);

    if (isWebOrder(telegramId)) {
        const webUserId = telegramId.replace('webuser_', '');
        await WebUser.findByIdAndUpdate(webUserId, { $inc: { [creditField]: 1 } }).catch(() => {});
        return;
    }

    await User.findOneAndUpdate(
        { telegramId },
        { $inc: { [creditField]: 1 } }
    ).catch(() => {});
}

async function incrementInviteUsage(telegramId) {
    if (isWebOrder(telegramId)) {
        const webUserId = telegramId.replace('webuser_', '');
        await WebUser.findByIdAndUpdate(webUserId, { $inc: { totalInvites: 1 } }).catch(() => {});
        return;
    }

    await User.findOneAndUpdate(
        { telegramId },
        { $inc: { totalInvites: 1 }, $set: { lastActivityAt: new Date() } }
    ).catch(() => {});
}

let isProcessing = false;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_INVITES || '1');
let activeWorkers = 0;

async function enqueue(telegramId, targetEmail, tier = 'basic') {
    const guaranteeDays = getTierGuaranteeDays(tier);
    const job = await InviteJob.create({ telegramId, targetEmail, tier, guaranteeDays });
    const position = await InviteJob.countDocuments({ status: 'queued', createdAt: { $lt: job.createdAt } }) + 1;
    processQueue();
    return { jobId: job._id.toString(), position };
}

async function getQueuePosition(jobId) {
    const job = await InviteJob.findById(jobId);
    if (!job) return null;
    if (job.status !== 'queued') return { status: job.status };
    const position = await InviteJob.countDocuments({ status: 'queued', createdAt: { $lt: job.createdAt } }) + 1;
    return { status: 'queued', position };
}

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
                    await job.save().catch(() => {});
                    await notifyInviteFailed(job.targetEmail).catch(() => {});
                    await notifyUser(job.telegramId, job.targetEmail, err.message).catch(() => {});
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
    const { telegramId, targetEmail } = job;
    const tier = job.tier || 'basic';
    const isWeb = isWebOrder(telegramId);

    const account = await getAccountForJob();
    if (!account) {
        job.status = 'failed';
        job.result = 'no_account_available';
        await job.save();
        await notifyInviteFailed(targetEmail);
        await notifyUser(telegramId, targetEmail, 'Tidak ada akun tersedia saat ini. Coba lagi nanti.');
        return;
    }

    const reservedCredit = await reserveUserCredit(telegramId, tier);
    if (!reservedCredit) {
        await Account.findByIdAndUpdate(account._id, { $inc: { reservedSlots: -1 } }).catch(() => {});
        job.status = 'failed';
        job.result = 'credits_insufficient';
        await job.save();
        await notifyInviteFailed(targetEmail);
        await notifyUser(telegramId, targetEmail, 'Kredit tidak cukup');
        return;
    }

    let nsName = null;
    let result = null;

    try {
        try {
            nsName = await getOrCreateNamespace(account._id);
            if (nsName) {
                console.log(`[Queue] VPN namespace: ${nsName} -> akun ${account.email}`);
            }
        } catch (vpnErr) {
            console.warn('[Queue] VPN setup gagal, fallback ke proxy:', vpnErr.message);
        }

        try {
            console.log(`[Queue] Starting invite for ${targetEmail} using account ${account.email} (tier: ${tier}${nsName ? ', vpn: ' + nsName : ''})`);
            result = await inviteTeamMember(account, targetEmail, nsName);
            console.log(`[Queue] Invite result for ${targetEmail}:`, JSON.stringify(result));
        } finally {
            await Account.findByIdAndUpdate(account._id, { $inc: { reservedSlots: -1 } }).catch(() => {});
        }

        if (!result || !result.success) {
            await refundUserCredit(telegramId, tier);
            job.status = 'failed';
            job.result = result?.message || 'Invite gagal';
            await job.save();
            await notifyInviteFailed(targetEmail);
            await notifyUser(telegramId, targetEmail, job.result);
            return;
        }

        await incrementInviteUsage(telegramId);

        await Account.findByIdAndUpdate(
            account._id,
            { $inc: { inviteCount: 1 }, $set: { lastUsed: new Date() } }
        );

        const newInviteCount = account.inviteCount + 1;
        if (newInviteCount >= account.maxInvites) {
            await Account.findByIdAndUpdate(account._id, { status: 'full' });
            await notifyAccountStatusChange(account.email, 'active', 'full').catch(() => {});
            try { await releaseAccount(account._id); } catch (_) {}
        }

        const guaranteeDays = getTierGuaranteeDays(tier);
        if (guaranteeDays > 0) {
            const guaranteeUntil = new Date();
            guaranteeUntil.setDate(guaranteeUntil.getDate() + guaranteeDays);
            job.guaranteeUntil = guaranteeUntil;
        }

        const tierLabel = { basic: 'Basic', standard: 'Standard', premium: 'Premium' };
        await Transaction.create({
            telegramId,
            type: 'invite_used',
            credits: -1,
            invitedEmail: targetEmail,
            tier,
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
                    ? `\nGaransi: ${guaranteeDays} hari (sampai ${job.guaranteeUntil.toLocaleDateString('id-ID')})`
                    : '\nTanpa garansi';
                await bot.api.sendMessage(
                    telegramId,
                    `Invite berhasil!\n\n${targetEmail} sudah diinvite ke ChatGPT Plus!${guaranteeMsg}`,
                    { parse_mode: 'Markdown' }
                );
            } catch (_) {}
        }
    } catch (err) {
        if (!result || !result.success) {
            await refundUserCredit(telegramId, tier).catch(() => {});
        }
        throw err;
    }
}

async function notifyUser(telegramId, targetEmail, reason) {
    if (isWebOrder(telegramId)) return;
    try {
        const { bot } = require('../bot/userHandlers');
        await bot.api.sendMessage(
            telegramId,
            `Invite gagal\n\nEmail: \`${targetEmail}\`\n\nKredit kamu tidak dikurangi. Silakan coba lagi nanti atau hubungi admin.`,
            { parse_mode: 'Markdown' }
        );
    } catch (err) {
        console.error('[Queue] Failed to notify user:', err.message);
    }
}

module.exports = { enqueue, getQueuePosition, processQueue };
