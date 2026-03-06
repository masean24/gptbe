/**
 * Test script untuk debug login flow.
 *
 * Cara pakai:
 *   node test-login.js <account_email> [--proxy IP:PORT]
 *
 * Contoh:
 *   node test-login.js erutan@reditd.asia
 *   node test-login.js erutan@reditd.asia --proxy 45.3.34.245:3129
 *
 * Script ini akan:
 *   - Connect ke MongoDB
 *   - Cari akun berdasarkan email
 *   - Jalankan login flow (headless: false biar bisa diliat)
 *   - Simpan session ke database kalau berhasil
 */

require('dotenv').config();
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const speakeasy = require('speakeasy');
const mongoose = require('mongoose');
const { parseProxy } = require('./src/services/playwrightService');

chromium.use(StealthPlugin());

// ============ PARSE ARGS ============
const rawArgs = process.argv.slice(2);
let proxyServer = null;
let accountEmail = null;

for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--proxy' && rawArgs[i + 1]) {
        const p = rawArgs[i + 1];
        proxyServer = p.startsWith('http') ? p : `http://${p}`;
        i++;
    } else if (!accountEmail) {
        accountEmail = rawArgs[i];
    }
}

if (!accountEmail) {
    console.log('❌ Usage: node test-login.js <account_email> [--proxy IP:PORT]');
    process.exit(1);
}

const MONGODB_URI = process.env.MONGODB_URI || 'PASTE_MONGODB_URI_HERE';

const accountSchema = new mongoose.Schema({
    email: String,
    password: String,
    twoFASecret: String,
    inviteCount: Number,
    maxInvites: Number,
    status: String,
    hasSession: Boolean,
    sessionData: String,
    lastUsed: Date,
    notes: String,
});
const Account = mongoose.model('Account', accountSchema);

// ============ LOGIN FLOW ============
async function runLogin(account) {
    const tag = `[Login][${account.email}]`;

    const launchOptions = {
        headless: false,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox'],
    };

    if (proxyServer) {
        launchOptions.proxy = parseProxy(proxyServer);
        console.log(`${tag} Using proxy: ${JSON.stringify(launchOptions.proxy)}`);
    }

    const browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    try {
        // Step 1: Buka chatgpt.com → klik Log in (kanan atas)
        const randomDelay = (min, max) => page.waitForTimeout(Math.floor(Math.random() * (max - min + 1)) + min);

        console.log(`${tag} Step 1: Navigating to chatgpt.com...`);
        await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await randomDelay(5000, 8000);
        console.log(`${tag} URL: ${page.url()}`);

        console.log(`${tag} Step 1: Clicking "Log in" button...`);
        await page.click('button:has-text("Log in")');
        await randomDelay(3000, 5000);

        // Step 2: Popup "Log in or sign up" → isi email → klik Continue
        console.log(`${tag} Step 2: Filling email...`);
        await page.waitForSelector('input[placeholder="Email address"]', { timeout: 15000 });
        await randomDelay(1000, 2000);
        await page.fill('input[placeholder="Email address"]', account.email);
        console.log(`${tag} Step 2: Email filled, clicking Continue...`);
        await randomDelay(1500, 3000);
        await page.click('button[type="submit"]:has-text("Continue")');
        await randomDelay(4000, 6000);

        // Step 3: Cek apakah ada halaman email-verification (Check your inbox)
        const urlAfterEmail = page.url();
        console.log(`${tag} Step 3: URL after email: ${urlAfterEmail}`);
        if (urlAfterEmail.includes('email-verification')) {
            console.log(`${tag} Step 3: Email verification page detected! Clicking "Continue with password"...`);
            await page.click('button:has-text("Continue with password")');
            await randomDelay(3000, 5000);
        }

        // Step 3b: isi password → klik Continue
        console.log(`${tag} Step 3: Waiting for password field...`);
        console.log(`${tag} URL: ${page.url()}`);
        const passwordInput = await page.waitForSelector('input[type="password"], input[placeholder="Password"]', { timeout: 30000 });
        await randomDelay(1000, 2000);
        console.log(`${tag} Step 3: Filling password...`);
        await passwordInput.fill(account.password);
        await randomDelay(1500, 3000);
        console.log(`${tag} Step 3: Clicking Continue...`);
        await page.click('button:has-text("Continue")');
        await randomDelay(5000, 8000);

        // Step 4: Handle 2FA (auth.openai.com/mfa-challenge/...)
        const currentUrlAfterPassword = page.url();
        console.log(`${tag} URL after password: ${currentUrlAfterPassword}`);

        if (currentUrlAfterPassword.includes('mfa-challenge')) {
            console.log(`${tag} Step 4: 2FA detected!`);
            if (!account.twoFASecret) {
                throw new Error('Akun memiliki 2FA tapi twoFASecret tidak diisi di database');
            }
            const token = speakeasy.totp({ secret: account.twoFASecret, encoding: 'base32' });
            console.log(`${tag} Step 4: Generated TOTP: ${token}`);
            const codeInput = await page.waitForSelector('input[placeholder="One-time code"], input[placeholder="Code"]', { timeout: 15000 });
            await randomDelay(1000, 2000);
            await codeInput.fill(token);
            await randomDelay(1500, 3000);
            console.log(`${tag} Step 4: Clicking Continue...`);
            await page.click('button:has-text("Continue")');
            await randomDelay(5000, 8000);
        } else {
            console.log(`${tag} Step 4: No 2FA, skipping...`);
        }

        // Tunggu redirect ke chatgpt.com
        console.log(`${tag} Waiting for redirect to chatgpt.com...`);
        try {
            await page.waitForURL(/chatgpt\.com/, { timeout: 60000 });
        } catch (_) { }

        await page.waitForTimeout(5000);

        // Handle workspace selection (jika ada)
        const workspaceBtnCount = await page.locator('button[name="workspace_id"]').count();
        if (workspaceBtnCount > 0) {
            console.log(`${tag} Workspace selection detected, clicking first...`);
            await page.locator('button[name="workspace_id"]').first().click({ force: true });
            try { await page.waitForURL(/chatgpt\.com/, { timeout: 60000 }); } catch (_) { }
            await page.waitForTimeout(5000);
        }

        // Check final URL
        const finalUrl = page.url();
        console.log(`${tag} Final URL: ${finalUrl}`);

        const isLoggedIn = finalUrl.includes('chatgpt.com') && !finalUrl.includes('auth');
        if (!isLoggedIn) {
            throw new Error('Login gagal - URL masih di halaman auth: ' + finalUrl);
        }

        // Save session
        const sessionData = await context.storageState();
        await browser.close();

        return { success: true, sessionData: JSON.stringify(sessionData) };

    } catch (error) {
        console.error(`${tag} ❌ ERROR: ${error.message}`);
        // Screenshot saat error
        try {
            const ssPath = `./debug-login-${Date.now()}.png`;
            await page.screenshot({ path: ssPath, fullPage: true });
            console.log(`${tag} Screenshot saved: ${ssPath}`);
        } catch (_) { }
        // Jangan langsung close, biar user bisa inspect browser
        console.log(`${tag} Browser tetap terbuka 30 detik biar bisa inspect...`);
        await page.waitForTimeout(30000);
        try { await browser.close(); } catch (_) { }
        return { success: false, message: error.message };
    }
}

// ============ MAIN ============
async function main() {
    console.log(`\n🔧 Config:`);
    console.log(`   Account : ${accountEmail}`);
    console.log(`   Proxy   : ${proxyServer || '(none)'}\n`);

    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected!\n');

    const account = await Account.findOne({ email: accountEmail });
    if (!account) {
        console.log(`❌ Akun "${accountEmail}" tidak ditemukan di database.`);
        await mongoose.disconnect();
        process.exit(1);
    }

    console.log(`📋 Akun ditemukan:`);
    console.log(`   Email    : ${account.email}`);
    console.log(`   Status   : ${account.status}`);
    console.log(`   Has2FA   : ${account.twoFASecret ? 'Yes' : 'No'}`);
    console.log(`   HasSession: ${account.hasSession}`);
    console.log('');

    console.log('🚀 Starting login...\n');
    const result = await runLogin(account);

    if (result.success) {
        console.log('\n✅ LOGIN BERHASIL!');

        // Update session di database
        await Account.updateOne(
            { _id: account._id },
            {
                $set: {
                    sessionData: result.sessionData,
                    hasSession: true,
                    lastUsed: new Date(),
                }
            }
        );
        console.log('💾 Session berhasil disimpan ke database.');
    } else {
        console.log(`\n❌ LOGIN GAGAL: ${result.message}`);
    }

    await mongoose.disconnect();
    console.log('\n👋 Done!');
}

main().catch(console.error);
