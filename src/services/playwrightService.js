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
        // Step 1: Navigate to team admin page
        console.log(`[Playwright] Step 1: Navigating to admin members page...`);
        await page.goto('https://chatgpt.com/admin/organization/members', {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });
        await page.waitForTimeout(5000);

        const currentUrl = page.url();
        console.log(`[Playwright] Current URL after navigation: ${currentUrl}`);

        // Check for session expiry
        if (currentUrl.includes('auth') || currentUrl.includes('login')) {
            await sendScreenshotToAdmin(page, 'session_expired');
            console.log('[Playwright] Session expired - redirected to auth');
            await browser.close();
            browserInstance = null;
            return { success: false, message: 'Session expired. Silakan login ulang akun via /loginaccount' };
        }

        // Step 2: Log page state for debugging
        const pageTitle = await page.title();
        console.log(`[Playwright] Page title: ${pageTitle}`);

        await sendScreenshotToAdmin(page, 'page_loaded');

        // Log all buttons on page for debugging
        const buttons = await page.$$eval('button', els => els.map(el => ({
            text: el.textContent?.trim()?.substring(0, 50),
            class: el.className?.substring(0, 50),
            disabled: el.disabled,
        })));
        console.log(`[Playwright] Buttons found on page:`, JSON.stringify(buttons, null, 2));

        // Also log all links
        const links = await page.$$eval('a', els => els.map(el => ({
            text: el.textContent?.trim()?.substring(0, 50),
            href: el.href,
        })));
        console.log(`[Playwright] Links found on page:`, JSON.stringify(links.slice(0, 20), null, 2));

        // Step 3: Handle workspace onboarding if needed
        const onboardingExists = await page.locator('button:has-text("Skip"), button:has-text("Continue")').count() > 0;
        if (onboardingExists) {
            console.log('[Playwright] Onboarding detected, clicking Skip/Continue...');
            await page.click('button:has-text("Skip"), button:has-text("Continue")');
            await page.waitForTimeout(2000);
        }

        // Step 4: Try to find the Invite button with multiple selectors
        console.log('[Playwright] Step 4: Looking for invite button...');
        const inviteSelectors = [
            'button:has-text("Invite")',
            'button:has-text("Add member")',
            'button:has-text("Add people")',
            'button:has-text("Undang")',
            'a:has-text("Invite")',
            'a:has-text("Add member")',
            'a:has-text("Add people")',
            '[data-testid*="invite"]',
            '[aria-label*="invite" i]',
            '[aria-label*="add member" i]',
        ];

        let inviteButton = null;
        for (const selector of inviteSelectors) {
            const count = await page.locator(selector).count();
            if (count > 0) {
                console.log(`[Playwright] Found invite button with selector: ${selector}`);
                inviteButton = page.locator(selector).first();
                break;
            }
        }

        if (!inviteButton) {
            await sendScreenshotToAdmin(page, 'no_button_found');
            // Dump page HTML for analysis
            const bodyHtml = await page.$eval('body', el => el.innerHTML.substring(0, 5000));
            console.log(`[Playwright] Page body HTML (first 5000 chars):\n${bodyHtml}`);

            await browser.close();
            browserInstance = null;
            return { success: false, message: 'Tombol invite tidak ditemukan. UI ChatGPT mungkin sudah berubah. Screenshot dikirim ke admin.' };
        }

        await inviteButton.click();
        console.log('[Playwright] Invite button clicked');
        await page.waitForTimeout(2000);
        await sendScreenshotToAdmin(page, 'after_invite_click');

        // Step 5: Fill in email
        console.log(`[Playwright] Step 5: Looking for email input for ${targetEmail}...`);
        const emailSelectors = [
            'input[type="email"]',
            'input[placeholder*="email" i]',
            'input[placeholder*="Email"]',
            'input[name*="email" i]',
            'input[aria-label*="email" i]',
        ];

        let emailInput = null;
        for (const selector of emailSelectors) {
            const count = await page.locator(selector).count();
            if (count > 0) {
                console.log(`[Playwright] Found email input with selector: ${selector}`);
                emailInput = page.locator(selector).first();
                break;
            }
        }

        if (!emailInput) {
            await sendScreenshotToAdmin(page, 'no_email_input');
            await browser.close();
            browserInstance = null;
            return { success: false, message: 'Input email tidak ditemukan setelah klik invite.' };
        }

        await emailInput.fill(targetEmail);
        console.log(`[Playwright] Email filled: ${targetEmail}`);
        await page.waitForTimeout(1000);

        // Step 6: Submit invite
        console.log('[Playwright] Step 6: Looking for submit button...');
        const submitSelectors = [
            'button[type="submit"]',
            'button:has-text("Send invite")',
            'button:has-text("Send")',
            'button:has-text("Invite")',
            'button:has-text("Kirim")',
            'button:has-text("Add")',
        ];

        let submitBtn = null;
        for (const selector of submitSelectors) {
            const count = await page.locator(selector).count();
            if (count > 0) {
                const btn = page.locator(selector).first();
                const isDisabled = await btn.isDisabled().catch(() => false);
                if (!isDisabled) {
                    console.log(`[Playwright] Found submit button with selector: ${selector}`);
                    submitBtn = btn;
                    break;
                }
            }
        }

        if (!submitBtn) {
            await sendScreenshotToAdmin(page, 'no_submit_btn');
            await browser.close();
            browserInstance = null;
            return { success: false, message: 'Tombol submit invite tidak ditemukan.' };
        }

        await submitBtn.click();
        console.log('[Playwright] Submit button clicked');
        await page.waitForTimeout(3000);
        await sendScreenshotToAdmin(page, 'after_submit');

        // Step 7: Check result
        console.log('[Playwright] Step 7: Checking result...');
        const pageText = await page.textContent('body');
        console.log(`[Playwright] Page text after submit (first 1000 chars): ${pageText?.substring(0, 1000)}`);

        const successPatterns = ['invited', 'berhasil', 'sent', 'success', 'pending'];
        const errorPatterns = ['already', 'sudah', 'error', 'gagal', 'failed', 'invalid'];

        const lowerText = pageText?.toLowerCase() || '';

        for (const pattern of errorPatterns) {
            if (lowerText.includes(pattern)) {
                await browser.close();
                browserInstance = null;
                return { success: false, message: `${targetEmail} sudah pernah diinvite atau email tidak valid.` };
            }
        }

        await browser.close();
        browserInstance = null;
        return { success: true, message: `Invite berhasil dikirim ke ${targetEmail}` };
    } catch (error) {
        console.error(`[Playwright] Error during invite:`, error.message);
        try { await sendScreenshotToAdmin(page, 'error'); } catch (_) { }
        try { await browser.close(); } catch (_) { }
        browserInstance = null;
        return { success: false, message: `Error: ${error.message}` };
    }
}

module.exports = { loginAccount, inviteTeamMember };
