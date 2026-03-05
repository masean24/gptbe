/**
 * Email Service — Nodemailer SMTP
 * Sends styled HTML emails (redeem codes, notifications)
 */

const nodemailer = require('nodemailer');

let transporter = null;

function initTransporter() {
    if (transporter) return transporter;

    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT || '587');
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (!host || !user || !pass) {
        console.warn('[Email] SMTP not configured — email sending disabled');
        return null;
    }

    transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
    });

    console.log(`[Email] SMTP configured: ${user} via ${host}:${port}`);
    return transporter;
}

/**
 * Send a redeem code to user via email
 */
async function sendRedeemCode(toEmail, code, credits = 1) {
    const t = initTransporter();
    if (!t) {
        console.error('[Email] Cannot send — SMTP not configured');
        return false;
    }

    const from = process.env.SMTP_FROM || process.env.SMTP_USER;

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#FFF9DB;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="max-width:500px;margin:40px auto;padding:0;">
    
    <!-- Header -->
    <div style="background:#FFD600;border:3px solid #000;padding:24px 32px;text-align:center;">
      <h1 style="margin:0;font-size:28px;color:#000;font-weight:900;">🤖 GPT Invite Bot</h1>
    </div>
    
    <!-- Body -->
    <div style="background:#fff;border:3px solid #000;border-top:none;padding:32px;">
      <h2 style="margin:0 0 12px;font-size:22px;color:#000;">🎁 Kode Redeem Kamu!</h2>
      <p style="color:#333;font-size:15px;line-height:1.6;margin:0 0 24px;">
        Admin telah menyetujui akun kamu. Gunakan kode di bawah ini untuk mendapatkan <strong>${credits} kredit</strong> gratis!
      </p>
      
      <!-- Code Box -->
      <div style="background:#FFD600;border:3px solid #000;padding:20px;text-align:center;box-shadow:4px 4px 0 #000;">
        <p style="margin:0 0 4px;font-size:12px;color:#555;text-transform:uppercase;letter-spacing:2px;font-weight:700;">Kode Redeem</p>
        <p style="margin:0;font-size:32px;font-weight:900;color:#000;letter-spacing:4px;font-family:monospace;">${code}</p>
      </div>
      
      <div style="margin:24px 0 0;padding:16px;background:#F0FFF0;border:2px solid #000;">
        <p style="margin:0;font-size:14px;color:#333;">
          <strong>Cara pakai:</strong><br>
          1. Login ke dashboard web<br>
          2. Masukkan kode di menu "Redeem Code"<br>
          3. Kredit akan otomatis masuk ke saldo kamu!
        </p>
      </div>
    </div>
    
    <!-- Footer -->
    <div style="background:#000;border:3px solid #000;padding:16px 32px;text-align:center;">
      <p style="margin:0;font-size:12px;color:#999;">
        GPT Invite Bot — Akses ChatGPT Team otomatis
      </p>
    </div>
    
  </div>
</body>
</html>`;

    try {
        await t.sendMail({
            from,
            to: toEmail,
            subject: '🎁 Kode Redeem GPT Invite Bot — Kredit Gratis!',
            html,
        });
        console.log(`[Email] Redeem code sent to ${toEmail}`);
        return true;
    } catch (err) {
        console.error(`[Email] Failed to send to ${toEmail}:`, err.message);
        return false;
    }
}

module.exports = { sendRedeemCode, initTransporter };
