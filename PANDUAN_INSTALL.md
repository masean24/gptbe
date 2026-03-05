# 🚀 Panduan Install Deploy GPT Invite Bot & Web (Newbie Friendly)

Panduan lengkap dari 0 sampai jalan untuk instalasi Backend (Bot Telegram & API) di VPS, dan Frontend (Web Next.js) di Vercel.

## 📦 1. Persiapan Awal
Pastikan kamu udah punya:
1. **VPS** (Ubuntu 20.04 / 22.04 recommended) - untuk backend.
2. **Akun GitHub** (untuk simpan source code backend & frontend).
3. **Akun Vercel** (untuk deploy web/frontend gratis).
4. **Akun MongoDB Atlas** (buat database gratis di cloud).
5. **Bot Telegram** (bikin di @BotFather, simpan Token API-nya).

---

## ⚙️ 2. Deploy Backend (Di VPS)

### A. Install Node.js, Git, & PM2 di VPS
Buka terminal VPS (pakai PuTTY / konek SSH), lalu jalankan perintah ini satu-satu:
```bash
sudo apt update
sudo apt install git curl -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2

# Install dependencies browser untuk Playwright (Wajib! Buat bot ngetik otomatis)
sudo apt install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2
```

### B. Download Source Code
Kalau codebase kamu ada di github, clone ke dalam VPS:
```bash
git clone https://github.com/masean24/gptbe.git backend-gpt
cd backend-gpt
```

### C. Install Dependencies & Playwright
```bash
npm install
npx playwright install chromium
```

### D. Setup Konfigurasi (.env)
Buat file rahasia `.env` dari file contoh.
```bash
cp .env.example .env
nano .env
```
Isi variabel yang penting aja dulu:
- `BOT_TOKEN`: Token dari BotFather
- `ADMIN_IDS`: ID Telegram kamu (ambil dari @userinfobot)
- `MONGODB_URI`: Link koneksi MongoDB kamu
- `JWT_SECRET`: Isi dengan random text (misal: `RAHAsiaBGT123!!`)
- Konfigurasi lain seperti `SMTP` dan `Force Join` bisa kamu isi nyesuaiin kebutuhan.

Kalau udah ngisi semuanya, tekan: `Ctrl + X`, lalu tekan `Y`, lalu `Enter` untuk nyimpen.

### E. Jalankan Bot & API (Jalan 24 Jam)
```bash
pm2 start src/server.js --name gpti-bot
pm2 save
pm2 startup
```
Yeay! Backend API & Bot Telegram kamu sekarang udah nyala terus di VPS. 🎊

---

## 🌐 3. Deploy Frontend (Di Vercel)

Karena frontend dibuat pakai **Next.js**, cara paling gampang, cepat & **gratis** adalah pakai Vercel.

1. Buka [Vercel.com](https://vercel.com) dan daftar/login pakai akun GitHub kamu.
2. Klik tombol **Add New...** > **Project**.
3. Cari repo Frontend kamu (yg nyimpen kode frontend), lalu klik **Import**.
4. Scroll ke bawah buka bagian **Environment Variables**, tambahkan 1 variable wajib ini:
   - Name: `NEXT_PUBLIC_API_URL`
   - Value: `http://IP_VPS_KAMU:3000` *(ganti dengan IP/Domain VPS kamu, contoh: `http://103.111.99.88:3000`)*
5. Klik **Deploy** dan tunggu 1-2 menit prosesnya.
6. Kalau udah sukses, kamu bakal dapet URL webnya (misal: `https://gptv2-masean.vercel.app`).

> **PENTING: Jangan Ragu Balik Ke VPS**
> Buka VPS kamu lagi, lalu masukin URL web kamu tadi ke file `.env` di variabel `FRONTEND_URL` biar fiturnya (kayak login/register) nggak error kena blokir keamanan (CORS).
> ```bash
> nano .env
> # Update baris ini -> FRONTEND_URL=https://gptv2-masean.vercel.app
> pm2 restart gpti-bot
> ```

---

## 🛠 4. Finalisasi (Penting!)

1. **Jadikan Bot Telegram sebagai Admin Group/Channel**
   Kalau kamu nyalain fitur "Force Join" (wajib join channel/grup), pastikan bot telegram kamu ditambahkan sebagai **Admin** di Channel & Group tersebut.
   
2. **Setup Email Gmail (SMTP)**
   Fitur register web, approve admin, ganti password, dll itu butuh bot ngirim email ke user.
   - Pake akun Gmail biasa. Pastikan aktifin **2-Step Verification**.
   - Ke settingan akun Google > Tab Security > Cari/search fitur **App Passwords**.
   - Bikin 1 sandi baru (namain misal "Web Bot GPT").
   - Bakal muncul password 16 huruf. Copy password itu masukkan ke file `.env` kamu di bagian `SMTP_PASS`. Jangan lupa disave trs restart PM2 lagi.

---

🎉 **SEMUA SELESAI!**
- **Akses Web Kamu:** Buka link dari Vercel tadi.
- **Akses Admin Panel:** Tambahin `/Maseans24` di belakang link Vercel kamu (contoh: `https://webkamu.vercel.app/Maseans24`). Loginnya tinggal klik, gausah pake password kalau telegram ID kamu ada di `ADMIN_IDS` (env).
- **Akses Bot:** Coba chat bot kamu di Telegram `/start`!
