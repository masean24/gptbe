/**
 * Test script untuk debug invite flow secara lokal dengan browser VISIBLE.
 *
 * Cara pakai:
 *   1. Pastikan sudah `npm install` di folder backend
 *   2. Set MONGODB_URI di .env atau langsung di bawah
 *   3. Jalankan: node test-invite.js
 *
 * Script ini akan:
 *   - Connect ke MongoDB
 *   - Ambil akun ChatGPT pertama yang punya session
 *   - Buka browser VISIBLE (bukan headless)
 *   - Jalankan flow invite step by step
 *   - Pause di setiap step supaya kamu bisa lihat
 */

require('dotenv').config();
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const mongoose = require('mongoose');
const readline = require('readline');

chromium.use(StealthPlugin());

// ============ CONFIG ============
const MONGODB_URI = process.env.MONGODB_URI || 'PASTE_MONGODB_URI_HERE';
const TARGET_EMAIL = process.argv[2] || 'test@example.com';
// ================================

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function pause(msg = 'Tekan ENTER untuk lanjut...') {
    return new Promise(resolve => rl.question(`\n⏸️  ${msg}\n`, resolve));
}

// Load ChatGPT account model (matches src/models/Account.js)
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

async function main() {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected!\n');

    // Find account with session
    const account = await Account.findOne({ hasSession: true, status: 'active' });
    if (!account) {
        console.log('❌ Tidak ada akun dengan session aktif di database.');
        process.exit(1);
    }
    console.log(`📧 Akun: ${account.email}`);
    console.log(`🎯 Target invite: ${TARGET_EMAIL}\n`);

    // Launch visible browser
    console.log('🌐 Launching browser (VISIBLE mode)...');
    const browser = await chromium.launch({
        headless: false,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
        slowMo: 500, // Perlambat supaya bisa dilihat
    });

    const context = await browser.newContext({
        storageState: JSON.parse(account.sessionData),
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    try {
        // ============ Step 1: Navigate ============
        console.log('\n📍 Step 1: Navigating to chatgpt.com...');
        await page.goto('https://chatgpt.com/', {
            waitUntil: 'networkidle',
            timeout: 60000,
        });

        const currentUrl = page.url();
        console.log(`   URL: ${currentUrl}`);

        if (currentUrl.includes('auth') || currentUrl.includes('login')) {
            console.log('❌ Session expired! Redirect ke login page.');
            await pause('Browser terbuka, cek manual. Tekan ENTER untuk close.');
            await browser.close();
            process.exit(1);
        }

        console.log('   Waiting for page to fully load...');
        await page.waitForTimeout(5000);

        const title = await page.title();
        console.log(`   Title: ${title}`);

        await pause('Lihat browser. Tekan ENTER untuk buka sidebar & cari invite button...');

        // ============ Step 2: Open sidebar & find invite button ============
        console.log('\n📍 Step 2: Opening sidebar...');
        const openSidebarBtn = page.locator('button[aria-label="Open sidebar"]');
        if ((await openSidebarBtn.count()) > 0) {
            await openSidebarBtn.click();
            console.log('   ✅ Sidebar opened!');
            await page.waitForTimeout(2000);
        } else {
            console.log('   ℹ️ Sidebar already open or toggle not found');
        }

        console.log('   Looking for "Invite team members" button...');
        let inviteBtn = page.locator('button:has-text("Invite team members")');
        let inviteBtnCount = await inviteBtn.count();
        console.log(`   "Invite team members" buttons found: ${inviteBtnCount}`);

        if (inviteBtnCount > 0) {
            console.log('   ✅ Found! Clicking...');
            await inviteBtn.first().click();
            await page.waitForTimeout(3000);
        } else {
            console.log('   ❌ Not found.');
            await pause('Coba klik manual "Invite team members" di browser, lalu tekan ENTER...');
        }

        await pause('Popup muncul? Tekan ENTER untuk step 3 (fill email)...');

        // ============ Step 3: Fill email ============
        console.log(`\n📍 Step 3: Filling email: ${TARGET_EMAIL}`);
        const emailInputs = page.locator('input[placeholder="Email"]');
        const emailCount = await emailInputs.count();
        console.log(`   Email inputs found: ${emailCount}`);

        if (emailCount > 0) {
            await emailInputs.first().fill(TARGET_EMAIL);
            console.log('   ✅ Email filled!');
        } else {
            console.log('   ❌ Email input not found!');
            const allInputs = await page.$$eval('input', els => els.map(el => ({
                type: el.type,
                placeholder: el.placeholder,
                name: el.name,
            })));
            console.log('   All inputs:', JSON.stringify(allInputs, null, 2));
            await pause('Isi email manual di browser, lalu tekan ENTER...');
        }

        await pause('Email terisi? Tekan ENTER untuk step 4 (click Next)...');

        // ============ Step 4: Click Next ============
        console.log('\n📍 Step 4: Clicking "Next"...');
        const nextBtn = page.locator('button:has-text("Next")');
        if ((await nextBtn.count()) > 0) {
            await nextBtn.first().click();
            console.log('   ✅ Next clicked!');
            await page.waitForTimeout(3000);
        } else {
            console.log('   ❌ Next button not found!');
            await pause('Klik Next manual, lalu tekan ENTER...');
        }

        await pause('Konfirmasi muncul? Tekan ENTER untuk step 5 (Send invites)...');

        // ============ Step 5: Click Send invites ============
        console.log('\n📍 Step 5: Clicking "Send invites"...');
        const sendBtn = page.locator('button:has-text("Send invites"), button:has-text("Send invite")');
        if ((await sendBtn.count()) > 0) {
            await sendBtn.first().click();
            console.log('   ✅ Send invites clicked!');
        } else {
            console.log('   ❌ Send invites button not found!');
            await pause('Klik Send invites manual, lalu tekan ENTER...');
        }

        // ============ Step 6: Wait for toast ============
        console.log('\n📍 Step 6: Waiting for green toast (max 20s)...');
        let success = false;
        for (let i = 0; i < 20; i++) {
            await page.waitForTimeout(1000);
            const pageText = (await page.textContent('body'))?.toLowerCase() || '';
            if (pageText.includes('invited') && pageText.includes('user')) {
                console.log('   ✅✅✅ SUCCESS! Toast "Invited X user" detected!');
                success = true;
                break;
            }
            process.stdout.write(`   ⏳ ${i + 1}s...`);
        }

        if (!success) {
            console.log('\n   ❌ No success toast detected after 20s');
        }

        console.log('\n🏁 RESULT:', success ? '✅ BERHASIL' : '❌ GAGAL');

        await pause('Selesai! Tekan ENTER untuk close browser...');
    } catch (error) {
        console.error('\n❌ ERROR:', error.message);
        await pause('Error terjadi. Cek browser. Tekan ENTER untuk close...');
    }

    await browser.close();
    await mongoose.disconnect();
    rl.close();
    console.log('\n👋 Done!');
}

main().catch(console.error);
