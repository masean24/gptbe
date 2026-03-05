/**
 * Test script untuk debug invite flow.
 *
 * Cara pakai:
 *   node test-invite.js [email1] [email2] ... --proxy IP:PORT
 *
 * Contoh:
 *   node test-invite.js a@gmail.com --proxy 45.3.34.245:3129
 *   node test-invite.js a@gmail.com b@gmail.com --proxy 45.3.34.245:3129
 *   node test-invite.js a@gmail.com b@gmail.com   (tanpa proxy)
 *
 * Script ini akan:
 *   - Connect ke MongoDB
 *   - Ambil akun aktif sebanyak jumlah email
 *   - Jalankan semua invite PARALEL, masing-masing browser sendiri
 *   - Opsional pakai HTTP proxy
 */

require('dotenv').config();
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const mongoose = require('mongoose');
const { parseProxy } = require('./src/services/playwrightService');

chromium.use(StealthPlugin());

// ============ PARSE ARGS ============
const rawArgs = process.argv.slice(2);
let proxyServer = null;
const emailArgs = [];

for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--proxy' && rawArgs[i + 1]) {
        const p = rawArgs[i + 1];
        proxyServer = p.startsWith('http') ? p : `http://${p}`;
        i++;
    } else {
        emailArgs.push(rawArgs[i]);
    }
}

const TARGET_EMAILS = emailArgs.length > 0 ? emailArgs : ['test@example.com'];
const MONGODB_URI = process.env.MONGODB_URI || 'PASTE_MONGODB_URI_HERE';
// ====================================

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

// ============ SINGLE INVITE WORKER ============
async function runInvite(account, targetEmail, workerIndex) {
    const tag = `[Worker-${workerIndex}][${targetEmail}]`;
    console.log(`${tag} Starting...`);

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
        storageState: JSON.parse(account.sessionData),
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    try {
        // Step 1: Navigate
        console.log(`${tag} Step 1: Navigating to chatgpt.com...`);
        await page.goto('https://chatgpt.com/', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(4000);

        const currentUrl = page.url();
        if (currentUrl.includes('auth') || currentUrl.includes('login')) {
            console.log(`${tag} ❌ Session expired!`);
            await browser.close();
            return { email: targetEmail, success: false, reason: 'session_expired' };
        }
        console.log(`${tag} URL: ${currentUrl}`);

        // Step 2: Open sidebar
        const openSidebarBtn = page.locator('button[aria-label="Open sidebar"]');
        if ((await openSidebarBtn.count()) > 0) {
            await openSidebarBtn.click();
            await page.waitForTimeout(1500);
        }

        // Step 3: Click invite button
        console.log(`${tag} Step 2: Looking for "Invite team members"...`);
        const inviteBtn = page.locator('button:has-text("Invite team members")');
        if ((await inviteBtn.count()) === 0) {
            console.log(`${tag} ❌ Invite button not found`);
            await browser.close();
            return { email: targetEmail, success: false, reason: 'no_invite_button' };
        }
        await inviteBtn.first().click();
        // Wait longer for popup to fully render
        await page.waitForTimeout(6000);

        // Step 4: Fill email
        console.log(`${tag} Step 3: Filling email ${targetEmail}...`);
        let emailFilled = false;
        for (let attempt = 0; attempt < 15; attempt++) {
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
            await page.waitForTimeout(1000);
        }

        if (!emailFilled) {
            console.log(`${tag} ❌ Email input not found`);
            await browser.close();
            return { email: targetEmail, success: false, reason: 'no_email_input' };
        }

        // Step 5: Click Next
        console.log(`${tag} Step 4: Clicking Next...`);
        const nextBtn = page.locator('button:has-text("Next")');
        if ((await nextBtn.count()) > 0) {
            await nextBtn.first().click();
            await page.waitForTimeout(3000);
        } else {
            console.log(`${tag} ❌ Next button not found`);
            await browser.close();
            return { email: targetEmail, success: false, reason: 'no_next_button' };
        }

        // Step 6: Click Send invites
        console.log(`${tag} Step 5: Clicking Send invites...`);
        const sendBtn = page.locator('button:has-text("Send invites"), button:has-text("Send invite")');
        if ((await sendBtn.count()) > 0) {
            await sendBtn.first().click();
        } else {
            console.log(`${tag} ❌ Send invites button not found`);
            await browser.close();
            return { email: targetEmail, success: false, reason: 'no_send_button' };
        }

        // Step 7: Wait for success toast
        console.log(`${tag} Step 6: Waiting for success toast...`);
        let success = false;
        for (let i = 0; i < 20; i++) {
            await page.waitForTimeout(1000);
            const pageText = (await page.textContent('body'))?.toLowerCase() || '';
            if (pageText.includes('invited') && pageText.includes('user')) {
                success = true;
                break;
            }
        }

        await browser.close();
        console.log(`${tag} ${success ? '✅ BERHASIL' : '❌ GAGAL (no toast)'}`);
        return { email: targetEmail, success, reason: success ? null : 'no_success_toast' };

    } catch (error) {
        console.error(`${tag} ❌ ERROR: ${error.message}`);
        await browser.close();
        return { email: targetEmail, success: false, reason: error.message };
    }
}

// ============ MAIN ============
async function main() {
    console.log(`\n🔧 Config:`);
    console.log(`   Emails  : ${TARGET_EMAILS.join(', ')}`);
    console.log(`   Proxy   : ${proxyServer || '(none)'}`);
    console.log(`   Workers : ${TARGET_EMAILS.length} paralel\n`);

    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected!\n');

    const accounts = await Account.find({ hasSession: true, status: 'active' }).limit(TARGET_EMAILS.length);
    if (accounts.length === 0) {
        console.log('❌ Tidak ada akun dengan session aktif.');
        process.exit(1);
    }

    if (accounts.length < TARGET_EMAILS.length) {
        console.log(`⚠️  Hanya ada ${accounts.length} akun aktif, tapi ${TARGET_EMAILS.length} email diminta.`);
        console.log(`   Akan jalankan ${accounts.length} invite saja.\n`);
    }

    const tasks = TARGET_EMAILS.slice(0, accounts.length).map((email, i) => ({
        account: accounts[i],
        email,
        index: i + 1,
    }));

    console.log('📋 Tasks:');
    tasks.forEach(t => console.log(`   [${t.index}] ${t.email} → akun: ${t.account.email}`));
    console.log('');

    const results = await Promise.all(
        tasks.map(t => runInvite(t.account, t.email, t.index))
    );

    console.log('\n' + '═'.repeat(40));
    console.log('📊 HASIL:');
    results.forEach(r => {
        console.log(`  ${r.success ? '✅' : '❌'} ${r.email}${r.reason ? ` — ${r.reason}` : ''}`);
    });
    const ok = results.filter(r => r.success).length;
    console.log(`\n  Total: ${ok}/${results.length} berhasil`);
    console.log('═'.repeat(40));

    await mongoose.disconnect();
    console.log('\n👋 Done!');
}

main().catch(console.error);
