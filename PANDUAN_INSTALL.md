# 🚀 Panduan Deploy GPT Invite Bot v2 (Newbie Friendly)

Panduan lengkap dari 0 sampai jalan:
- **Backend** (Bot Telegram + API) → di **VPS**
- **Frontend** (Web Next.js) → di **Vercel**
- **Database** → di **MongoDB Atlas** (gratis)
- **Domain + HTTPS** → pakai **Cloudflare** (gratis)

---

## 📦 1. Persiapan Awal

Pastikan kamu punya:
1. **VPS** (Ubuntu 20.04 / 22.04) — untuk backend
2. **Akun GitHub** — untuk simpan source code
3. **Akun Vercel** — untuk deploy frontend (gratis)
4. **Akun MongoDB Atlas** — database cloud (gratis)
5. **Bot Telegram** — bikin di @BotFather, simpan Token API-nya
6. **Domain** — yang sudah di-manage lewat **Cloudflare DNS**
7. **Akun QRIS** — daftar di `qris.hubify.store` untuk pembayaran

---

## ⚙️ 2. Deploy Backend (Di VPS)

### A. Install Node.js, Git, & PM2

Buka terminal VPS (SSH), jalankan satu-satu:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install git curl -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

### B. Install Dependencies Browser (untuk Playwright)

Untuk **Ubuntu 20.04 / 22.04**:
```bash
sudo apt install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2
```

Untuk **Ubuntu 24.04** (Jika muncul error `libasound2 is a virtual package`):
```bash
sudo apt install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64
```

### C. Clone & Install

```bash
git clone https://github.com/masean24/gptbe.git
cd gptbe
npm install
npx playwright install chromium
```

### D. Setup .env

```bash
cp .env.example .env
nano .env
```

Isi variabel-variabel ini:

| Variable | Penjelasan |
|----------|------------|
| `BOT_TOKEN` | Token dari @BotFather |
| `ADMIN_IDS` | Telegram ID kamu (cek di @userinfobot) |
| `LOG_CHAT_ID` | Chat ID channel/group untuk notifikasi (contoh: `-1001234567890`) |
| `MONGODB_URI` | Connection string dari MongoDB Atlas |
| `JWT_SECRET` | Random text apapun (contoh: `RAHAsiaBGT123!!`) |
| `QRIS_API_URL` | `https://qris.hubify.store/api` |
| `QRIS_API_KEY` | API Key dari dashboard qris.hubify.store |
| `QRIS_WEBHOOK_SECRET` | (kosongkan jika tidak dipakai) |
| `CREDIT_PRICE` | Harga per invite dalam Rupiah (contoh: `10000`) |
| `MAX_INVITES_PER_ACCOUNT` | Max invite per akun ChatGPT (contoh: `4`) |
| `FRONTEND_URL` | URL web Vercel kamu (isi nanti setelah deploy frontend) |
| `WEB_ACCESS_PASSWORD` | Password untuk akses web (contoh: `mypass123`) |

Simpan: `CTRL+X` → `Y` → `Enter`

### E. Jalankan Bot (24 Jam)

```bash
pm2 start src/main.js --name gpti-bot
pm2 save
pm2 startup
```

> Jalankan perintah yang muncul dari `pm2 startup` agar bot auto-start saat VPS restart.

✅ Backend & Bot Telegram kamu sekarang nyala terus!

---

## 🔒 3. Setup Domain + HTTPS (Cloudflare)

### A. DNS Record

1. Buka **Cloudflare Dashboard** → pilih domain kamu
2. Masuk ke **DNS** → tambah record:
   - Type: **A**
   - Name: `gpts` (atau subdomain yang kamu mau, contoh: `api`)
   - IPv4: **IP VPS kamu**
   - Proxy status: **Proxied** (☁️ orange cloud)

### B. Buat Cloudflare Origin Certificate

1. Di Cloudflare → **SSL/TLS** → **Origin Server**
2. Klik **Create Certificate**
3. Biarkan default:
   - ✅ Let Cloudflare generate a private key and a CSR
   - Hostnames: `*.domainmu.com`, `domainmu.com`
   - Validity: 15 years
4. Klik **Create**
5. **JANGAN TUTUP HALAMANNYA** — akan muncul 2 kotak:
   - **Origin Certificate** (`-----BEGIN CERTIFICATE-----`)
   - **Private Key** (`-----BEGIN PRIVATE KEY-----`)

### C. Simpan Certificate di VPS

```bash
# Buat folder
sudo mkdir -p /etc/ssl/cloudflare

# Simpan certificate
sudo nano /etc/ssl/cloudflare/cert.pem
# → Paste "Origin Certificate" → CTRL+X → Y → Enter

# Simpan private key
sudo nano /etc/ssl/cloudflare/key.pem
# → Paste "Private Key" → CTRL+X → Y → Enter
```

### D. Setup Nginx

```bash
# Install Nginx
sudo apt install -y nginx

# Buat config
sudo nano /etc/nginx/sites-available/gpti-api
```

Isi dengan:

```nginx
server {
    listen 80;
    listen 443 ssl;
    server_name gpts.domainmu.com;

    ssl_certificate /etc/ssl/cloudflare/cert.pem;
    ssl_certificate_key /etc/ssl/cloudflare/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Simpan, lalu aktifkan:

```bash
# Hapus default site & aktifkan config baru
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -s /etc/nginx/sites-available/gpti-api /etc/nginx/sites-enabled/gpti-api

# Test & reload
sudo nginx -t
sudo systemctl reload nginx
```

### E. Buka Port Firewall

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow ssh
sudo ufw enable
```

> ⚠️ Jika VPS menggunakan **Alibaba Cloud / AWS / GCP**, buka juga port 80 & 443 di **Security Group** console cloud-nya.

### F. Pastikan SSL Mode di Cloudflare

1. Cloudflare → **SSL/TLS** → **Overview**
2. Pilih mode: **Full**

### G. Test

Buka di browser: `https://gpts.domainmu.com/health`

Harus muncul: `{"status":"ok"}` ✅

---

## 🌐 4. Deploy Frontend (Di Vercel)

1. Buka [vercel.com](https://vercel.com) → login pakai GitHub
2. Klik **Add New** → **Project**
3. Import repo frontend kamu (contoh: `masean24/gptfe`)
4. Di bagian **Environment Variables**, tambahkan:
   - Name: `NEXT_PUBLIC_API_URL`
   - Value: `https://gpts.domainmu.com` *(URL dari step 3)*
5. Klik **Deploy** → tunggu 1-2 menit
6. Dapat URL web (contoh: `https://gpt-delta-blue.vercel.app`)

### Setelah Deploy:

Balik ke VPS, update `.env` backend:
```bash
nano .env
# Update baris ini:
# FRONTEND_URL=https://gpt-delta-blue.vercel.app
# (TANPA trailing slash!)
pm2 restart gpti-bot
```

---

## � 5. Setup QRIS Webhook

1. Login ke dashboard `qris.hubify.store`
2. Masuk ke **Webhooks** → set URL:
   ```
   https://gpts.domainmu.com/api/webhooks/qris
   ```
3. Simpan — sekarang pembayaran QRIS otomatis masuk ke bot!

---

## 🛠 6. Finalisasi

### Tambah Akun ChatGPT

Di bot Telegram, ketik:
```
/addaccount email@gmail.com password123
```
Lalu login:
```
/loginaccount <account_id>
```

### Notifikasi ke Channel/Group

1. Buat channel/group Telegram
2. Tambahkan bot sebagai **Admin**
3. Forward pesan dari channel ke **@userinfobot** untuk dapat Chat ID
4. Masukkan ke `.env`: `LOG_CHAT_ID=-100xxxxxxxxx`
5. `pm2 restart gpti-bot`

### Custom Domain di Vercel (Opsional)

1. Di Vercel → Project Settings → Domains → tambah domain kamu
2. Di Cloudflare DNS, tambah CNAME record:
   - Name: `gpt` (atau subdomain yang kamu mau)
   - Target: `cname.vercel-dns.com`
   - Proxy: **DNS only** (☁️ gray cloud)

---

## 📋 Perintah PM2 Berguna

```bash
pm2 logs gpti-bot          # Lihat log bot
pm2 restart gpti-bot       # Restart bot
pm2 stop gpti-bot          # Stop bot
pm2 status                 # Cek status semua proses
```

## 📋 Update Code dari GitHub

```bash
cd ~/gptbe
git pull origin main
pm2 restart gpti-bot
```

---

🎉 **SELESAI!**
- **Web:** Buka URL Vercel kamu
- **Bot Telegram:** Chat `/start` ke bot kamu
- **Admin:** Ketik `/admin` di bot (khusus ADMIN_IDS)
