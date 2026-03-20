'use strict';

const cron = require('node-cron');
const Account = require('../models/Account');
const InviteJob = require('../models/InviteJob');
const { getOrCreateNamespace } = require('./vpnService');
const { loginAccount, launchBrowser } = require('./playwrightService');

/**
 * Attempt re-login and retry check. Used by multiple detection cases.
 */
async function attemptReLogin(account, reason) {
    console.log(`[Checker][${account.email}] ${reason} — attempting re-login...`);
    try {
        const loginResult = await loginAccount(account);
        if (loginResult.success) {
            await Account.findByIdAndUpdate(account._id, {
                sessionData: loginResult.sessionData,
                hasSession: true,
            });
            account.sessionData = loginResult.sessionData;
            return await checkAccount(account);
        } else {
            await Account.findByIdAndUpdate(account._id, {
                workspaceStatus: 'error',
                lastCheckedAt: new Date(),
                hasSession: false,
            });
            return { success: false, message: `${reason}, re-login failed: ${loginResult.message}` };
        }
    } catch (err) {
        await Account.findByIdAndUpdate(account._id, {
            workspaceStatus: 'error',
            lastCheckedAt: new Date(),
            hasSession: false,
        });
        return { success: false, message: `${reason}, re-login error: ${err.message}` };
    }
}

/**
 * Check a single ChatGPT account:
 * - Navigate to /admin/members to scrape active members
 * - Navigate to /admin/members?tab=invites to scrape pending invites
 * - Update Account in DB with results
 */
async function checkAccount(account) {
    console.log(`[Checker] Checking account: ${account.email}`);

    // VPN setup — same flow as invite
    let nsName = null;
    try {
        nsName = await getOrCreateNamespace(account._id);
        if (nsName) console.log(`[Checker] VPN namespace: ${nsName}`);
    } catch (vpnErr) {
        console.warn('[Checker] VPN setup gagal, fallback ke proxy:', vpnErr.message);
    }

    // Session check
    if (!account.sessionData) {
        console.log(`[Checker] Account ${account.email} has no session, attempting login...`);
        try {
            const loginResult = await loginAccount(account);
            if (loginResult.success) {
                await Account.findByIdAndUpdate(account._id, {
                    sessionData: loginResult.sessionData,
                    hasSession: true,
                });
                account.sessionData = loginResult.sessionData;
            } else {
                await Account.findByIdAndUpdate(account._id, {
                    workspaceStatus: 'error',
                    lastCheckedAt: new Date(),
                });
                return { success: false, message: `Login failed: ${loginResult.message}` };
            }
        } catch (loginErr) {
            await Account.findByIdAndUpdate(account._id, {
                workspaceStatus: 'error',
                lastCheckedAt: new Date(),
            });
            return { success: false, message: `Login error: ${loginErr.message}` };
        }
    }

    const proxy = account.assignedProxy || null;
    const browser = await launchBrowser(proxy, nsName);
    let context;
    try {
        context = await browser.newContext({
            storageState: JSON.parse(account.sessionData),
            viewport: { width: 1920, height: 1080 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        });
    } catch (err) {
        await browser.close();
        await Account.findByIdAndUpdate(account._id, {
            workspaceStatus: 'error',
            lastCheckedAt: new Date(),
        });
        return { success: false, message: `Session parse error: ${err.message}` };
    }

    const page = await context.newPage();
    const members = [];

    try {
        // ============ Step 1: Navigate to /admin/members (Users tab) ============
        console.log(`[Checker][${account.email}] Step 1: Navigating to /admin/members...`);
        await page.goto('https://chatgpt.com/admin/members', {
            waitUntil: 'networkidle',
            timeout: 60000,
        });
        await page.waitForTimeout(5000);

        const currentUrl = page.url();
        console.log(`[Checker][${account.email}] URL: ${currentUrl}`);

        // Get page content for detection
        const bodyText = (await page.textContent('body'))?.trim() || '';
        const bodyLower = bodyText.toLowerCase();
        const bodyLen = bodyText.length;
        console.log(`[Checker][${account.email}] Body length: ${bodyLen} chars`);

        // ── Case 1: Blank white page (stale session, body almost empty) ──
        if (bodyLen < 50) {
            console.log(`[Checker][${account.email}] Blank page detected (${bodyLen} chars) — session stale`);
            await browser.close();
            await Account.findByIdAndUpdate(account._id, {
                workspaceStatus: 'error',
                lastCheckedAt: new Date(),
                hasSession: false,
            });
            return { success: false, message: 'Session stale (blank page), perlu re-login' };
        }

        // ── Case 2: "Oops, an error occurred! (account_deactivated)" → BANNED ──
        if (bodyLower.includes('account_deactivated') || bodyLower.includes('oops, an error occurred')) {
            console.log(`[Checker][${account.email}] ❌ Account DEACTIVATED/BANNED`);
            await browser.close();
            await Account.findByIdAndUpdate(account._id, {
                workspaceStatus: 'suspended',
                lastCheckedAt: new Date(),
                hasSession: false,
            });
            return { success: true, workspaceStatus: 'suspended', members: [], message: 'Account deactivated/banned' };
        }

        // ── Case 3: ChatGPT homepage with "Log in" / "Sign up for free" → not logged in ──
        if (bodyLower.includes('sign up for free') || bodyLower.includes('log in to get answers')) {
            console.log(`[Checker][${account.email}] Not logged in (ChatGPT homepage detected)`);
            await browser.close();

            // Attempt re-login
            return await attemptReLogin(account, 'Not logged in (homepage)');
        }

        // ── Case 4: "Your session has expired" popup ──
        if (bodyLower.includes('session has expired') || bodyLower.includes('session expired')) {
            console.log(`[Checker][${account.email}] Session expired popup detected`);
            await browser.close();

            return await attemptReLogin(account, 'Session expired popup');
        }

        // ── Case 4b: URL redirect to auth/login ──
        if (currentUrl.includes('auth') || currentUrl.includes('login')) {
            console.log(`[Checker][${account.email}] Redirected to login page: ${currentUrl}`);
            await browser.close();

            return await attemptReLogin(account, `Redirected to ${currentUrl}`);
        }

        // ── Case 5: Logged in ChatGPT but NOT on /admin/members → no admin access ──
        if (!currentUrl.includes('/admin/members') && !currentUrl.includes('/admin')) {
            console.log(`[Checker][${account.email}] ⚠️ Logged in but no admin access (URL: ${currentUrl})`);
            await browser.close();
            await Account.findByIdAndUpdate(account._id, {
                workspaceStatus: 'error',
                lastCheckedAt: new Date(),
            });
            return { success: false, message: `No admin access — redirected to ${currentUrl}` };
        }

        // ── Still check for legacy suspended/banned text ──
        if (bodyLower.includes('suspended') || bodyLower.includes('banned')) {
            console.log(`[Checker][${account.email}] Account appears suspended/banned`);
            await browser.close();
            await Account.findByIdAndUpdate(account._id, {
                workspaceStatus: 'suspended',
                lastCheckedAt: new Date(),
            });
            return { success: true, workspaceStatus: 'suspended', members: [] };
        }

        // ============ Step 2: Scrape active members ============
        console.log(`[Checker][${account.email}] Step 2: Scraping active members...`);

        // Wait for the member rows to appear
        await page.waitForSelector('table, [role="table"], [class*="member"], [class*="user"]', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(3000);

        // Extract member emails from the Users tab
        // The page shows rows with Name (+ email below) | Account type | Date added
        const activeMembers = await page.evaluate(() => {
            const results = [];
            // Look for all elements that contain email-like text
            const allElements = document.querySelectorAll('td, div, span, p');
            const emailRegex = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

            for (const el of allElements) {
                const text = el.textContent?.trim();
                if (text && emailRegex.test(text)) {
                    // Check if this row is an "Owner" — skip it
                    const row = el.closest('tr') || el.closest('[role="row"]') || el.parentElement?.parentElement;
                    const rowText = row?.textContent || '';
                    const isOwner = rowText.includes('Owner');

                    if (!isOwner) {
                        // Try to get Date added from the same row
                        let dateAdded = null;
                        const dateCells = row?.querySelectorAll('td, div, span');
                        if (dateCells) {
                            for (const cell of dateCells) {
                                const ct = cell.textContent?.trim();
                                if (ct && /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d/.test(ct)) {
                                    dateAdded = ct;
                                    break;
                                }
                            }
                        }

                        results.push({ email: text, dateAdded });
                    }
                }
            }
            return results;
        });

        console.log(`[Checker][${account.email}] Active members found: ${activeMembers.length}`);
        for (const m of activeMembers) {
            members.push({ email: m.email, status: 'active', joinedAt: m.dateAdded || null });
        }

        // ============ Step 3: Navigate to Pending invites tab ============
        console.log(`[Checker][${account.email}] Step 3: Navigating to pending invites...`);
        await page.goto('https://chatgpt.com/admin/members?tab=invites', {
            waitUntil: 'networkidle',
            timeout: 60000,
        });
        await page.waitForTimeout(5000);

        // Scrape pending invite emails
        const pendingMembers = await page.evaluate(() => {
            const results = [];
            const allElements = document.querySelectorAll('td, div, span, p');
            const emailRegex = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

            for (const el of allElements) {
                const text = el.textContent?.trim();
                if (text && emailRegex.test(text)) {
                    // Get Date invited from same row
                    let dateInvited = null;
                    const row = el.closest('tr') || el.closest('[role="row"]') || el.parentElement?.parentElement;
                    const dateCells = row?.querySelectorAll('td, div, span');
                    if (dateCells) {
                        for (const cell of dateCells) {
                            const ct = cell.textContent?.trim();
                            if (ct && /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d/.test(ct)) {
                                dateInvited = ct;
                                break;
                            }
                        }
                    }

                    results.push({ email: text, dateInvited });
                }
            }
            return results;
        });

        console.log(`[Checker][${account.email}] Pending invites found: ${pendingMembers.length}`);
        for (const m of pendingMembers) {
            members.push({ email: m.email, status: 'pending', joinedAt: m.dateInvited || null });
        }

        // ============ Step 4: Cross-reference with InviteJob DB ============
        console.log(`[Checker][${account.email}] Step 4: Cross-referencing with InviteJob database...`);

        // Get all emails that were legitimately invited by the bot for this account
        const botInviteJobs = await InviteJob.find({
            accountId: account._id.toString(),
            status: 'done',
        }).select('targetEmail').lean();

        const botInvitedEmails = new Set(botInviteJobs.map(j => j.targetEmail.toLowerCase()));
        console.log(`[Checker][${account.email}] Bot-invited emails in DB: ${botInvitedEmails.size}`);

        // Tag each member with source
        for (const m of members) {
            m.source = botInvitedEmails.has(m.email.toLowerCase()) ? 'bot' : 'unknown';
        }

        const unknownMembers = members.filter(m => m.source === 'unknown');
        if (unknownMembers.length > 0) {
            console.warn(`[Checker][${account.email}] ⚠️  ${unknownMembers.length} UNKNOWN member(s) detected: ${unknownMembers.map(m => m.email).join(', ')}`);
        }

        // ============ Step 5: Update DB ============
        const totalInviteCount = members.length; // active + pending both consume slots

        await Account.findByIdAndUpdate(account._id, {
            invitedMembers: members,
            workspaceStatus: 'active',
            lastCheckedAt: new Date(),
            inviteCount: totalInviteCount,
        });

        console.log(`[Checker][${account.email}] Done. Active: ${activeMembers.length}, Pending: ${pendingMembers.length}, Unknown: ${unknownMembers.length}, Total slots used: ${totalInviteCount}`);

        await browser.close();
        return {
            success: true,
            workspaceStatus: 'active',
            members,
            activeCount: activeMembers.length,
            pendingCount: pendingMembers.length,
            unknownCount: unknownMembers.length,
        };

    } catch (error) {
        console.error(`[Checker][${account.email}] Error:`, error.message);
        await browser.close().catch(() => {});

        await Account.findByIdAndUpdate(account._id, {
            workspaceStatus: 'error',
            lastCheckedAt: new Date(),
        });

        return { success: false, message: error.message };
    }
}

/**
 * Run checker for all active accounts sequentially.
 */
async function runCheckerCycle() {
    console.log('[Checker] Starting checker cycle...');

    const accounts = await Account.find({ status: { $in: ['active', 'full'] } }).lean();
    console.log(`[Checker] Found ${accounts.length} accounts to check`);

    let checked = 0;
    let skipped = 0;
    let errors = 0;

    for (const account of accounts) {
        try {
            // Skip if account has active invite job
            const activeJob = await InviteJob.findOne({
                accountId: account._id.toString(),
                status: 'processing',
            });
            if (activeJob) {
                console.log(`[Checker] Skipping ${account.email} — active invite job in progress`);
                skipped++;
                continue;
            }

            const result = await checkAccount(account);
            if (result.success) {
                checked++;
            } else {
                errors++;
            }

            // Small delay between accounts to be gentle
            await new Promise(r => setTimeout(r, 5000));

        } catch (err) {
            console.error(`[Checker] Unexpected error for ${account.email}:`, err.message);
            errors++;
        }
    }

    console.log(`[Checker] Cycle complete. Checked: ${checked}, Skipped: ${skipped}, Errors: ${errors}`);
}

/**
 * Start the scheduled checker cron job.
 * Runs every 6 hours: at 00:00, 06:00, 12:00, 18:00
 */
function startCheckerCron() {
    console.log('[Checker] Cron scheduled: every 6 hours (0 */6 * * *)');
    cron.schedule('0 */6 * * *', async () => {
        try {
            await runCheckerCycle();
        } catch (err) {
            console.error('[Checker] Cron cycle error:', err.message);
        }
    });
}

module.exports = { checkAccount, startCheckerCron };
