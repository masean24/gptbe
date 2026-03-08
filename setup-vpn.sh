#!/bin/bash
# setup-vpn.sh
# Setup awal VPN per-process (OpenVPN + Linux Network Namespace) untuk gpti-bot
# Jalankan sebagai root: sudo bash setup-vpn.sh

set -e

echo "======================================================"
echo "  gpti-bot VPN Setup (Surfshark + Linux netns)"
echo "======================================================"
echo ""

# 1. Install OpenVPN & iproute2
echo "[1/5] Install openvpn & iproute2..."
apt-get update -qq
apt-get install -y openvpn iproute2
echo "      ✓ openvpn $(openvpn --version | head -1)"
echo ""

# 2. Buat direktori config
echo "[2/5] Buat direktori /etc/surfshark/configs/..."
mkdir -p /etc/surfshark/configs
chmod 700 /etc/surfshark
echo "      ✓ Direktori siap"
echo ""

# 3. Test Linux Network Namespace support
echo "[3/5] Test Linux Network Namespace..."
ip netns add test_ns_gpti
ip netns del test_ns_gpti
echo "      ✓ ip netns berfungsi normal"
echo ""

# 4. Instruksi download Surfshark .ovpn configs
echo "[4/5] Download Surfshark .ovpn configs..."
echo ""
echo "      Download manual dari:"
echo "      https://my.surfshark.com/vpn/manual-setup/main/openvpn"
echo ""
echo "      Pilih UDP configs → download ZIP → extract → copy .ovpn files ke:"
echo "      /etc/surfshark/configs/"
echo ""
echo "      Contoh (setelah extract surfshark-configs.zip):"
echo "      cp ~/surfshark-configs/*.ovpn /etc/surfshark/configs/"
echo ""
echo "      File yang tersedia sekarang:"
ls /etc/surfshark/configs/*.ovpn 2>/dev/null | head -10 || echo "      (belum ada — download dulu)"
echo ""

# 5. Instruksi environment variables
echo "[5/5] Environment variables yang harus di-set di .env:"
echo ""
echo "      # Surfshark credentials (dari https://my.surfshark.com)"
echo "      SURFSHARK_USER=your_service_username"
echo "      SURFSHARK_PASS=your_service_password"
echo ""
echo "      # Direktori .ovpn configs"
echo "      SURFSHARK_CONFIGS_DIR=/etc/surfshark/configs"
echo ""
echo "      # (Opsional) Pilih file .ovpn tertentu, comma-separated."
echo "      # Akun 1-3 pakai file pertama, akun 4-6 pakai file kedua, dst."
echo "      # Kalau tidak di-set, semua file di SURFSHARK_CONFIGS_DIR akan di-round-robin."
echo "      SURFSHARK_OVPN_FILES=sg-sin.prod.surfshark.com_udp.ovpn,nl-ams.prod.surfshark.com_udp.ovpn"
echo ""
echo "======================================================"
echo "  Setup selesai! Restart bot setelah update .env"
echo "======================================================"
