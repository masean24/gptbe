const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const speakeasy = require('speakeasy');
const fs = require('fs');

chromium.use(StealthPlugin());

let browserInstance = null;

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);

/**
 * Save screenshot and send to admin via Telegram
 */
async function sendScreenshotToAdmin(page, label) {
    const path = `/tmp/invite_${label}.png`;
    try {
        await page.screenshot({ path });
        console.log(`[Playwright] Screenshot saved: ${path}`);
        // Send to admin via Telegram
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

async function launchBrowser() {
    if (browserInstance) {
        try { await browserInstance.close(); } catch (_) { }
    }
    browserInstance = await chromium.launch({
        headless: true,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox'],
    });
    return browserInstance;
}

/**
 * Login to ChatGPT and save session as JSON string (for MongoDB storage)
 */
async function loginAccount(account) {
    const browser = await launchBrowser();
    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    try {
        await page.goto('https://chat.openai.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);

        await page.click('button:has-text("Log in")');
        await page.waitForTimeout(2000);

        await page.waitForSelector('input[type="email"]', { timeout: 10000 });
        await page.fill('input[type="email"]', account.email);
        await page.click('button.btn-primary[type="submit"]');
        await page.waitForTimeout(2000);

        const passwordInput = await page.waitForSelector('input[type="password"]');
        await passwordInput.fill(account.password);
        await page.click('button[type="submit"]');
        await page.waitForTimeout(3000);

        // Handle 2FA
        const has2FA = await page.locator('input[type="text"][autocomplete="one-time-code"], input[name="code"]').count() > 0;
        if (has2FA && account.twoFASecret) {
            const token = speakeasy.totp({ secret: account.twoFASecret, encoding: 'base32' });
            const codeInput = await page.waitForSelector('input[type="text"][autocomplete="one-time-code"], input[name="code"]');
            await codeInput.fill(token);
            await page.click('button[type="submit"], button:has-text("Continue"), button:has-text("Verify")');
            await page.waitForTimeout(1500);
        }

        try {
            await page.waitForURL(/chatgpt\.com|auth\.openai\.com\/workspace/, { timeout: 60000 });
        } catch (_) { }

        await page.waitForTimeout(3000);

        // Handle workspace selection
        const workspaceBtn = await page.locator('button[name="workspace_id"]').count() > 0;
        if (workspaceBtn) {
            const firstBtn = page.locator('button[name="workspace_id"]').first();
            await firstBtn.click({ force: true });
            try { await page.waitForURL(/chatgpt\.com/, { timeout: 60000 }); } catch (_) { }
            await page.waitForTimeout(3000);
        }

        const currentUrl = page.url();
        const isLoggedIn = currentUrl.includes('chatgpt.com') && !currentUrl.includes('auth') && !currentUrl.includes('workspace');
        if (!isLoggedIn) throw new Error('Login gagal - URL masih di halaman auth');

        // Save session as JSON string for MongoDB
        const sessionData = await context.storageState();
        await browser.close();
        browserInstance = null;
        return { success: true, sessionData: JSON.stringify(sessionData) };
    } catch (error) {
        try { await browser.close(); } catch (_) { }
        browserInstance = null;
        return { success: false, message: error.message };
    }
}

/**
 * Invite a team member to ChatGPT Team workspace
 *
 * Flow (as of 2026-03):
 * 1. Go to chatgpt.com (main page, not admin)
 * 2. Click "Invite team members" button in bottom-left sidebar
 * 3. Popup with 5 email inputs appears ("Invite members to ... workspace")
 * 4. Fill first email input, click "Next"
 * 5. Confirm page shows email + role, click "Send invites"
 * 6. Wait for green toast "Invited 1 user to ..."
 */
async function inviteTeamMember(account, targetEmail) {
    const browser = await launchBrowser();

    let context;
    if (account.sessionData) {
        context = await browser.newContext({
            storageState: JSON.parse(account.sessionData),
            viewport: { width: 1280, height: 720 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        });
    } else {
        throw new Error('Akun belum memiliki session. Silakan login akun dulu.');
    }

    const page = await context.newPage();

    try {
        // ============ Step 1: Navigate to chatgpt.com ============
        console.log('[Playwright] Step 1: Navigating to chatgpt.com...');
        await page.goto('https://chatgpt.com/', {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });
        await page.waitForTimeout(5000);

        const currentUrl = page.url();
        console.log(`[Playwright] Current URL: ${currentUrl}`);

        if (currentUrl.includes('auth') || currentUrl.includes('login')) {
            await sendScreenshotToAdmin(page, 'session_expired');
            await browser.close();
            browserInstance = null;
            return { success: false, message: 'Session expired. Silakan login ulang akun via /loginaccount' };
        }



        // ============ Step 2: Click "Invite team members" button ============
        console.log('[Playwright] Step 2: Looking for "Invite team members" button...');
        const inviteBtn = page.locator('button:has-text("Invite team members")');
        const inviteBtnCount = await inviteBtn.count();
        console.log(`[Playwright] "Invite team members" buttons found: ${inviteBtnCount}`);

        if (inviteBtnCount === 0) {
            await sendScreenshotToAdmin(page, '2_no_invite_btn');
            await browser.close();
            browserInstance = null;
            return { success: false, message: 'Tombol "Invite team members" tidak ditemukan di sidebar.' };
        }

        await inviteBtn.first().click();
        console.log('[Playwright] "Invite team members" button clicked');
        await page.waitForTimeout(3000);

        // ============ Step 3: Fill email in first input ============
        console.log(`[Playwright] Step 3: Filling email ${targetEmail}...`);
        const emailInputs = page.locator('input[placeholder="Email"]');
        const emailInputCount = await emailInputs.count();
        console.log(`[Playwright] Email inputs found: ${emailInputCount}`);

        if (emailInputCount === 0) {
            const altInput = page.locator('input[type="email"], input[placeholder*="email" i]');
            const altCount = await altInput.count();
            if (altCount === 0) {
                await sendScreenshotToAdmin(page, '3_no_email_input');
                await browser.close();
                browserInstance = null;
                return { success: false, message: 'Input email tidak ditemukan di popup invite.' };
            }
            await altInput.first().fill(targetEmail);
        } else {
            await emailInputs.first().fill(targetEmail);
        }

        console.log(`[Playwright] Email filled: ${targetEmail}`);
        await page.waitForTimeout(1000);


        // ============ Step 4: Click "Next" ============
        console.log('[Playwright] Step 4: Clicking "Next"...');
        const nextBtn = page.locator('button:has-text("Next")');
        if ((await nextBtn.count()) === 0) {
            await sendScreenshotToAdmin(page, '4_no_next_btn');
            await browser.close();
            browserInstance = null;
            return { success: false, message: 'Tombol "Next" tidak ditemukan.' };
        }

        await nextBtn.first().click();
        console.log('[Playwright] "Next" clicked');
        await page.waitForTimeout(3000);

        // ============ Step 5: Click "Send invites" ============
        console.log('[Playwright] Step 5: Clicking "Send invites"...');
        const sendBtn = page.locator('button:has-text("Send invites"), button:has-text("Send invite")');
        if ((await sendBtn.count()) === 0) {
            await sendScreenshotToAdmin(page, '5_no_send_btn');
            await browser.close();
            browserInstance = null;
            return { success: false, message: 'Tombol "Send invites" tidak ditemukan.' };
        }

        await sendBtn.first().click();
        console.log('[Playwright] "Send invites" clicked');

        // ============ Step 6: Wait for green toast ============
        console.log('[Playwright] Step 6: Waiting for success toast...');
        let success = false;
        for (let i = 0; i < 20; i++) {
            await page.waitForTimeout(1000);
            const pageText = (await page.textContent('body'))?.toLowerCase() || '';
            if (pageText.includes('invited') && pageText.includes('user')) {
                console.log('[Playwright] Success toast detected!');
                success = true;
                break;
            }
        }

        await browser.close();
        browserInstance = null;

        if (success) {
            return { success: true, message: `Invite berhasil dikirim ke ${targetEmail}` };
        } else {
            await sendScreenshotToAdmin(page, 'no_confirmation');
            return { success: false, message: `Tidak ada konfirmasi invite untuk ${targetEmail}. Cek screenshot.` };
        }

    } catch (error) {
        console.error(`[Playwright] Error during invite:`, error.message);
        try { await sendScreenshotToAdmin(page, 'error'); } catch (_) { }
        try { await browser.close(); } catch (_) { }
        browserInstance = null;
        return { success: false, message: `Error: ${error.message}` };
    }
}

module.exports = { loginAccount, inviteTeamMember };
