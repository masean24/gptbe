const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const speakeasy = require('speakeasy');
const fs = require('fs');
const Account = require('../models/Account');
const { notifySessionExpired } = require('./notifyService');

chromium.use(StealthPlugin());

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);

// ============ PROXY POOL ============
const path = require('path');
const PROXY_FILE = path.join(__dirname, '../../proxy-list.txt');

function loadProxies() {
    try {
        return fs.readFileSync(PROXY_FILE, 'utf-8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'))
            .map(p => (p.startsWith('http') ? p : `http://${p}`));
    } catch {
        return [];
    }
}

let proxyIndex = 0;

function getNextProxy() {
    const proxies = loadProxies();
    if (proxies.length === 0) return null;
    const proxy = proxies[proxyIndex % proxies.length];
    proxyIndex++;
    return proxy;
}

/**
 * Parse proxy string into Playwright proxy config.
 * Supports: host:port, http://host:port, http://user:pass@host:port
 */
function parseProxy(proxyStr) {
    try {
        const url = new URL(proxyStr);
        const config = { server: `${url.protocol}//${url.host}` };
        if (url.username) config.username = decodeURIComponent(url.username);
        if (url.password) config.password = decodeURIComponent(url.password);
        return config;
    } catch {
        return { server: proxyStr };
    }
}

/**
 * Save screenshot and send to admin via Telegram
 */
async function sendScreenshotToAdmin(page, label) {
    const path = `/tmp/invite_${label}.png`;
    try {
        await page.screenshot({ path, fullPage: true });
        console.log(`[Playwright] Screenshot saved: ${path}`);
        if (ADMIN_IDS.length > 0) {
            const { bot } = require('../bot/userHandlers');
            const { InputFile } = require('grammy');
            const buffer = fs.readFileSync(path);
            for (const adminId of ADMIN_IDS) {
                await bot.api.sendPhoto(adminId, new InputFile(buffer, `${label}.png`), {
                    caption: `🖥️ Playwright Debug: ${label}`,
                }).catch(e => console.error('[Playwright] Failed to send screenshot:', e.message));
            }
        }
    } catch (err) {
        console.error(`[Playwright] Screenshot error:`, err.message);
    }
}

/**
 * Launch a fresh browser instance (each invite gets its own browser)
 */
async function launchBrowser(proxy) {
    const launchOptions = {
        headless: true,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',   // fix blank page di VPS (/dev/shm kecil)
            '--disable-gpu',
            '--no-zygote',
        ],
    };

    if (proxy) {
        launchOptions.proxy = parseProxy(proxy);
        console.log(`[Playwright] Using proxy: ${launchOptions.proxy.server}${launchOptions.proxy.username ? ' (with auth)' : ''}`);
    } else {
        console.warn('[Playwright] No proxy — using direct connection');
    }

    return chromium.launch(launchOptions);
}

/**
 * Dismiss any popup/modal by pressing Escape
 */
async function dismissPopups(page) {
    try {
        // Check for "Business workspace ready" or similar popups
        const popupTexts = ['workspace is ready', 'transfer chat', 'start as empty'];
        const bodyText = (await page.textContent('body'))?.toLowerCase() || '';
        const hasPopup = popupTexts.some(t => bodyText.includes(t));

        if (hasPopup) {
            console.log('[Playwright] Popup detected, pressing Escape...');
            await page.keyboard.press('Escape');
            await page.waitForTimeout(2000);

            // If popup persists, try clicking "Start as empty workspace" then Continue
            const emptyOption = page.locator('text=Start as empty workspace');
            if ((await emptyOption.count()) > 0) {
                await emptyOption.click();
                await page.waitForTimeout(1000);
                const continueBtn = page.locator('button:has-text("Continue")');
                if ((await continueBtn.count()) > 0) {
                    await continueBtn.first().click();
                    console.log('[Playwright] Clicked "Start as empty workspace" + Continue');
                    await page.waitForTimeout(3000);
                }
            }
        }
    } catch (err) {
        console.log('[Playwright] Popup dismiss error (non-fatal):', err.message);
    }
}

/**
 * Login to ChatGPT and save session as JSON string (for MongoDB storage)
 */
async function loginAccount(account) {
    // Login tanpa proxy — lebih stabil, proxy hanya untuk invite
    const browser = await launchBrowser(null);
    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    try {
        const randomDelay = (min, max) => page.waitForTimeout(Math.floor(Math.random() * (max - min + 1)) + min);

        // Step 1: Buka chatgpt.com dan klik "Log in" (kanan atas)
        console.log(`[Login][${account.email}] Step 1: Navigating to chatgpt.com...`);
        await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await randomDelay(5000, 8000);
        await sendScreenshotToAdmin(page, `login_1_loaded_${account.email.split('@')[0]}`);

        console.log(`[Login][${account.email}] Step 1: URL after load: ${page.url()}`);
        console.log(`[Login][${account.email}] Step 1: Clicking Log in button...`);
        await page.click('button:has-text("Log in")');
        await randomDelay(3000, 5000);

        // Step 2: Popup "Log in or sign up" → isi email → klik Continue
        console.log(`[Login][${account.email}] Step 2: Filling email...`);
        await page.waitForSelector('input[placeholder="Email address"]', { timeout: 15000 });
        await randomDelay(1000, 2000);
        await page.fill('input[placeholder="Email address"]', account.email);
        await randomDelay(1500, 3000);
        await page.click('button[type="submit"]:has-text("Continue")');
        await randomDelay(4000, 6000);

        // Step 3: Cek apakah ada halaman email-verification (Check your inbox)
        // Jika ada, klik "Continue with password" dulu
        const urlAfterEmail = page.url();
        console.log(`[Login][${account.email}] Step 3: URL after email: ${urlAfterEmail}`);
        await sendScreenshotToAdmin(page, `login_3_after_email_${account.email.split('@')[0]}`);
        if (urlAfterEmail.includes('email-verification')) {
            console.log(`[Login][${account.email}] Step 3: Email verification page detected, clicking Continue with password...`);
            await page.click('button:has-text("Continue with password")');
            await randomDelay(3000, 5000);
        }

        // Step 3b: Isi password → klik Continue
        console.log(`[Login][${account.email}] Step 3: Filling password...`);
        const passwordInput = await page.waitForSelector('input[type="password"], input[placeholder="Password"]', { timeout: 30000 });
        await randomDelay(1000, 2000);
        await passwordInput.fill(account.password);
        await randomDelay(1500, 3000);
        await page.click('button:has-text("Continue")');
        await randomDelay(5000, 8000);

        // Step 4: Handle 2FA (auth.openai.com/mfa-challenge/...)
        const currentUrlAfterPassword = page.url();
        if (currentUrlAfterPassword.includes('mfa-challenge')) {
            console.log(`[Login][${account.email}] Step 4: 2FA detected...`);
            if (!account.twoFASecret) throw new Error('Akun memiliki 2FA tapi twoFASecret tidak diisi di database');
            const token = speakeasy.totp({ secret: account.twoFASecret, encoding: 'base32' });
            const codeInput = await page.waitForSelector('input[placeholder="One-time code"], input[placeholder="Code"]', { timeout: 15000 });
            await randomDelay(1000, 2000);
            await codeInput.fill(token);
            await randomDelay(1500, 3000);
            await page.click('button:has-text("Continue")');
            await randomDelay(5000, 8000);
        }

        // Tunggu redirect ke chatgpt.com
        try {
            await page.waitForURL(/chatgpt\.com/, { timeout: 60000 });
        } catch (_) { }

        await page.waitForTimeout(5000);

        // Handle workspace selection (jika ada)
        const workspaceBtn = await page.locator('button[name="workspace_id"]').count() > 0;
        if (workspaceBtn) {
            console.log(`[Login][${account.email}] Selecting workspace...`);
            const firstBtn = page.locator('button[name="workspace_id"]').first();
            await firstBtn.click({ force: true });
            try { await page.waitForURL(/chatgpt\.com/, { timeout: 60000 }); } catch (_) { }
            await page.waitForTimeout(5000);
        }

        // Dismiss any popups
        await dismissPopups(page);

        const currentUrl = page.url();
        console.log(`[Login][${account.email}] Final URL: ${currentUrl}`);
        const isLoggedIn = currentUrl.includes('chatgpt.com') && !currentUrl.includes('auth');
        if (!isLoggedIn) {
            await sendScreenshotToAdmin(page, `login_failed_${account.email.split('@')[0]}`);
            throw new Error('Login gagal - URL masih di halaman auth: ' + currentUrl);
        }

        const sessionData = await context.storageState();
        await browser.close();
        return { success: true, sessionData: JSON.stringify(sessionData) };
    } catch (error) {
        try { await sendScreenshotToAdmin(page, `login_error_${account.email.split('@')[0]}`); } catch (_) { }
        try { await browser.close(); } catch (_) { }
        return { success: false, message: error.message };
    }
}

/**
 * Invite a team member to ChatGPT Team workspace
 * Each call gets its own browser + proxy from the pool.
 */
async function inviteTeamMember(account, targetEmail) {
    // Use per-account proxy first, fallback to proxy pool
    const proxy = account.assignedProxy || getNextProxy();
    return await inviteWithSession(account, targetEmail, proxy);
}

/**
 * Internal: perform invite with current session
 */
async function inviteWithSession(account, targetEmail, proxy) {
    if (!proxy && arguments.length < 3) proxy = account.assignedProxy || getNextProxy();
    const browser = await launchBrowser(proxy);

    let context;
    if (account.sessionData) {
        context = await browser.newContext({
            storageState: JSON.parse(account.sessionData),
            viewport: { width: 1920, height: 1080 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        });
    } else {
        await browser.close();
        throw new Error('Akun belum memiliki session. Silakan login akun dulu.');
    }

    const page = await context.newPage();

    try {
        // ============ Step 1: Navigate to chatgpt.com ============
        console.log(`[Playwright][${targetEmail}] Step 1: Navigating to chatgpt.com...`);
        await page.goto('https://chatgpt.com/', {
            waitUntil: 'networkidle',
            timeout: 90000,
        });
        await page.waitForTimeout(12000);

        const currentUrl = page.url();
        console.log(`[Playwright][${targetEmail}] URL: ${currentUrl}`);

        if (currentUrl.includes('auth') || currentUrl.includes('login')) {
            console.log(`[Playwright][${targetEmail}] Session expired! Attempting auto re-login...`);
            await sendScreenshotToAdmin(page, 'session_expired');
            await browser.close();

            // Auto re-login
            try {
                const loginResult = await loginAccount(account);
                if (loginResult.success) {
                    // Update session in DB
                    await Account.findByIdAndUpdate(account._id, {
                        sessionData: loginResult.sessionData,
                        hasSession: true,
                    });
                    account.sessionData = loginResult.sessionData;
                    await notifySessionExpired(account.email, true);
                    console.log(`[Playwright][${targetEmail}] Re-login successful, retrying invite...`);

                    // Retry invite with new session (non-recursive, inline)
                    return await inviteWithSession(account, targetEmail);
                } else {
                    await notifySessionExpired(account.email, false);
                    // Mark account as error
                    await Account.findByIdAndUpdate(account._id, { status: 'error' });
                    return { success: false, message: `Session expired. Re-login gagal: ${loginResult.message}` };
                }
            } catch (reloginErr) {
                await notifySessionExpired(account.email, false);
                await Account.findByIdAndUpdate(account._id, { status: 'error' });
                return { success: false, message: `Session expired. Re-login error: ${reloginErr.message}` };
            }
        }

        // ============ Dismiss popups ============
        await dismissPopups(page);

        // ============ Step 2: Open sidebar & click "Invite team members" ============
        console.log(`[Playwright][${targetEmail}] Step 2: Opening sidebar...`);
        const openSidebarBtn = page.locator('button[aria-label="Open sidebar"]');
        if ((await openSidebarBtn.count()) > 0) {
            await openSidebarBtn.click();
            console.log(`[Playwright][${targetEmail}] Sidebar opened`);
            await page.waitForTimeout(3000);
        }

        console.log(`[Playwright][${targetEmail}] Looking for "Invite team members" button...`);
        const inviteBtn = page.locator('button:has-text("Invite team members")');
        const inviteBtnCount = await inviteBtn.count();
        console.log(`[Playwright][${targetEmail}] Invite buttons found: ${inviteBtnCount}`);

        if (inviteBtnCount === 0) {
            await sendScreenshotToAdmin(page, 'no_invite_btn');
            await browser.close();
            return { success: false, message: 'Tombol "Invite team members" tidak ditemukan di sidebar.' };
        }

        await inviteBtn.first().click();
        console.log(`[Playwright][${targetEmail}] Invite button clicked`);
        await page.waitForTimeout(12000);

        // ============ Step 3: Fill email ============
        console.log(`[Playwright][${targetEmail}] Step 3: Filling email...`);
        let emailFilled = false;
        for (let attempt = 0; attempt < 20; attempt++) {
            const emailInputs = page.locator('input[placeholder="Email"]');
            if ((await emailInputs.count()) > 0) {
                await emailInputs.first().fill(targetEmail);
                emailFilled = true;
                break;
            }
            const altInput = page.locator('input[type="email"], input[placeholder*="email" i]');
            if ((await altInput.count()) > 0) {
                await altInput.first().fill(targetEmail);
                emailFilled = true;
                break;
            }
            console.log(`[Playwright][${targetEmail}] Email input not found, retrying... (${attempt + 1}/20)`);
            await page.waitForTimeout(2000);
        }

        if (!emailFilled) {
            await sendScreenshotToAdmin(page, 'no_email_input');
            await browser.close();
            return { success: false, message: 'Input email tidak ditemukan di popup invite.' };
        }

        console.log(`[Playwright][${targetEmail}] Email filled`);
        await page.waitForTimeout(2000);

        // ============ Step 4: Click "Next" ============
        console.log(`[Playwright][${targetEmail}] Step 4: Clicking Next...`);
        const nextBtn = page.locator('button:has-text("Next")');
        if ((await nextBtn.count()) === 0) {
            await sendScreenshotToAdmin(page, '4_no_next_btn');
            await browser.close();
            return { success: false, message: 'Tombol "Next" tidak ditemukan.' };
        }

        await nextBtn.first().click();
        console.log(`[Playwright][${targetEmail}] Next clicked`);
        await page.waitForTimeout(6000);

        // ============ Step 5: Click "Send invites" ============
        console.log(`[Playwright][${targetEmail}] Step 5: Clicking Send invites...`);
        const sendBtn = page.locator('button:has-text("Send invites"), button:has-text("Send invite")');
        if ((await sendBtn.count()) === 0) {
            await sendScreenshotToAdmin(page, '5_no_send_btn');
            await browser.close();
            return { success: false, message: 'Tombol "Send invites" tidak ditemukan.' };
        }

        await sendBtn.first().click();
        console.log(`[Playwright][${targetEmail}] Send invites clicked`);

        // ============ Step 6: Wait for success toast ============
        console.log(`[Playwright][${targetEmail}] Step 6: Waiting for success toast...`);
        let success = false;
        for (let i = 0; i < 25; i++) {
            await page.waitForTimeout(1500);
            const pageText = (await page.textContent('body'))?.toLowerCase() || '';
            if (pageText.includes('invited') && pageText.includes('user')) {
                console.log(`[Playwright][${targetEmail}] Success toast detected!`);
                success = true;
                break;
            }
        }

        if (success) {
            await browser.close();
            return { success: true, message: `Invite berhasil dikirim ke ${targetEmail}` };
        } else {
            await sendScreenshotToAdmin(page, 'no_confirmation');
            await browser.close();
            return { success: false, message: `Tidak ada konfirmasi invite untuk ${targetEmail}. Cek screenshot.` };
        }

    } catch (error) {
        console.error(`[Playwright][${targetEmail}] Error:`, error.message);
        try { await sendScreenshotToAdmin(page, 'error'); } catch (_) { }
        try { await browser.close(); } catch (_) { }
        return { success: false, message: `Error: ${error.message}` };
    }
}

module.exports = { loginAccount, inviteTeamMember, parseProxy };
