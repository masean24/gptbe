const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const speakeasy = require('speakeasy');

chromium.use(StealthPlugin());

let browserInstance = null;

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
        // Use stored session
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
        // Navigate to team admin page
        await page.goto('https://chatgpt.com/admin/organization/members', {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });
        await page.waitForTimeout(3000);

        const currentUrl = page.url();
        if (currentUrl.includes('auth') || currentUrl.includes('login')) {
            await browser.close();
            browserInstance = null;
            return { success: false, message: '❌ Session expired. Silakan login ulang akun ini.' };
        }

        // Handle workspace onboarding if needed
        const onboardingExists = await page.locator('button:has-text("Skip"), button:has-text("Continue")').count() > 0;
        if (onboardingExists) {
            await page.click('button:has-text("Skip"), button:has-text("Continue")');
            await page.waitForTimeout(2000);
        }

        // Click "Invite" button
        const inviteButton = await page.waitForSelector('button:has-text("Invite"), button:has-text("Add member"), button:has-text("Undang")', { timeout: 15000 });
        await inviteButton.click();
        await page.waitForTimeout(2000);

        // Fill in email
        const emailInput = await page.waitForSelector('input[type="email"], input[placeholder*="email"], input[placeholder*="Email"]', { timeout: 10000 });
        await emailInput.fill(targetEmail);
        await page.waitForTimeout(1000);

        // Submit invite
        const submitBtn = await page.waitForSelector('button[type="submit"]:has-text("Invite"), button:has-text("Send invite"), button:has-text("Kirim")', { timeout: 10000 });
        await submitBtn.click();
        await page.waitForTimeout(3000);

        // Check for success indicators
        const successEl = await page.locator('text=invited, text=berhasil, text=sent, text=success').count();
        if (successEl > 0) {
            await browser.close();
            browserInstance = null;
            return { success: true, message: `✅ Berhasil mengirim invite ke ${targetEmail}!` };
        }

        // Check for error messages
        const errorEl = await page.locator('text=already, text=sudah, text=error, text=gagal, text=failed').count();
        if (errorEl > 0) {
            await browser.close();
            browserInstance = null;
            return { success: false, message: `❌ ${targetEmail} sudah pernah diinvite atau email tidak valid.` };
        }

        await browser.close();
        browserInstance = null;
        return { success: true, message: `✅ Invite berhasil dikirim ke ${targetEmail}` };
    } catch (error) {
        try { await browser.close(); } catch (_) { }
        browserInstance = null;
        return { success: false, message: `❌ Error: ${error.message}` };
    }
}

module.exports = { loginAccount, inviteTeamMember };
