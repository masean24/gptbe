/**
 * Email Service — Brevo (Sendinblue) REST API
 * Sends styled HTML emails (redeem codes, notifications)
 * Requires env: BREVO_API_KEY, BREVO_SENDER_EMAIL, BREVO_SENDER_NAME (optional)
 */

const axios = require('axios');

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

/**
 * Send a redeem code to user via Brevo transactional email API
 */
async function sendRedeemCode(toEmail, code, credits = 1) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.error('[Email] BREVO_API_KEY not set — email sending disabled');
    return false;
  }

  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  if (!senderEmail) {
    console.error('[Email] BREVO_SENDER_EMAIL not set');
    return false;
  }

  const senderName = process.env.BREVO_SENDER_NAME || 'GPT Invite Bot';

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
        GPT Invite Bot — Akses ChatGPT Plus otomatis
      </p>
    </div>
    
  </div>
</body>
</html>`;

  try {
    await axios.post(
      BREVO_API_URL,
      {
        sender: { email: senderEmail, name: senderName },
        to: [{ email: toEmail }],
        subject: '🎁 Kode Redeem GPT Invite Bot — Kredit Gratis!',
        htmlContent: html,
      },
      {
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`[Email] Redeem code sent to ${toEmail} via Brevo`);
    return true;
  } catch (err) {
    console.error(`[Email] Brevo failed to send to ${toEmail}:`, err.response?.data || err.message);
    return false;
  }
}

module.exports = { sendRedeemCode };
