const InviteJob = require('../models/InviteJob');
const Account = require('../models/Account');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { inviteTeamMember } = require('./playwrightService');

let isProcessing = false;

/**
 * Add a new invite job to the queue
 */
async function enqueue(telegramId, targetEmail) {
    const job = await InviteJob.create({ telegramId, targetEmail });
    // Check queue position
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
                job.status = 'failed';
                job.result = `Internal error: ${err.message}`;
                await job.save();
            }
        }
    } finally {
        isProcessing = false;
    }
}

async function processJob(job) {
    const { telegramId, targetEmail } = job;

    // Get user
    const user = await User.findOne({ telegramId });
    if (!user || user.credits < 1) {
        job.status = 'failed';
        job.result = 'credits_insufficient';
        await job.save();
        return;
    }

    // Get available ChatGPT account
    const account = await Account.findOne({ status: 'active', $expr: { $lt: ['$inviteCount', '$maxInvites'] } });
    if (!account) {
        job.status = 'failed';
        job.result = 'no_account_available';
        await job.save();
        return;
    }

    // Do the invite via Playwright
    const result = await inviteTeamMember(account, targetEmail);

    if (result.success) {
        // Deduct credit from user
        user.credits -= 1;
        user.totalInvites += 1;
        user.lastActivityAt = new Date();
        await user.save();

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
    } else {
        // Don't deduct credits on failure
        job.status = 'failed';
        job.result = result.message;
        await job.save();
    }
}

module.exports = { enqueue, getQueuePosition, processQueue };
