/**
 * vpnService.js
 * VPN per-process via Linux Network Namespace + OpenVPN (Surfshark)
 *
 * Aturan:
 *   - 1 namespace = maks MAX_ACCOUNTS_PER_NS akun ChatGPT
 *   - Namespace assignment DETERMINISTIK by account creation order:
 *       rank = posisi akun di list (sort createdAt ASC)
 *       nsIndex = Math.floor(rank / MAX_ACCOUNTS_PER_NS)
 *   - Namespace bersifat persistent per-akun: hidup selama ada akun assigned
 *   - releaseAccount() dipanggil saat akun jadi 'full'/'error'
 *
 * Fallback: kalau openvpn tidak ada / netns gagal → return null → proxy biasa
 *
 * Env vars yang dibutuhkan:
 *   SURFSHARK_USER          — username Surfshark (dari dashboard)
 *   SURFSHARK_PASS          — password Surfshark
 *   SURFSHARK_CONFIGS_DIR   — direktori .ovpn configs (default: /etc/surfshark/configs)
 *   SURFSHARK_OVPN_FILES    — comma-separated filenames, misal: "sg.ovpn,nl.ovpn,us.ovpn"
 *                             (kalau kosong → pakai semua .ovpn di SURFSHARK_CONFIGS_DIR)
 */

'use strict';

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Account = require('../models/Account');

const MAX_ACCOUNTS_PER_NS = 3;
const CONFIGS_DIR = process.env.SURFSHARK_CONFIGS_DIR || '/etc/surfshark/configs';
const VPN_AUTH_FILE = '/tmp/vpn_surfshark_auth.txt';

/**
 * Daftar namespace yang sedang aktif.
 * Struktur: Map<nsName, { ovpnConfig: string, accountIds: string[], pid: number|null }>
 */
const vpnNamespaces = new Map();

// ── Inisialisasi ──────────────────────────────────────────────────────────────

let vpnEnabled = false;
let ovpnFiles = [];

function init() {
    const user = process.env.SURFSHARK_USER;
    const pass = process.env.SURFSHARK_PASS;

    if (!user || !pass) {
        console.log('[VPN] SURFSHARK_USER/PASS tidak di-set → VPN dinonaktifkan, pakai proxy biasa');
        return;
    }

    // Cek apakah openvpn & ip netns tersedia
    try {
        execSync('which openvpn', { stdio: 'ignore' });
        execSync('which ip', { stdio: 'ignore' });
    } catch {
        console.warn('[VPN] openvpn atau iproute2 tidak ditemukan → VPN dinonaktifkan');
        return;
    }

    // Tulis auth file dengan permission ketat
    try {
        fs.writeFileSync(VPN_AUTH_FILE, `${user}\n${pass}\n`, { mode: 0o600 });
    } catch (err) {
        console.warn('[VPN] Gagal tulis auth file:', err.message, '→ VPN dinonaktifkan');
        return;
    }

    // Load daftar .ovpn files
    const envFiles = process.env.SURFSHARK_OVPN_FILES;
    if (envFiles) {
        ovpnFiles = envFiles.split(',').map(f => f.trim()).filter(Boolean);
    } else {
        try {
            ovpnFiles = fs.readdirSync(CONFIGS_DIR).filter(f => f.endsWith('.ovpn'));
        } catch {
            console.warn(`[VPN] Tidak bisa baca direktori ${CONFIGS_DIR} → VPN dinonaktifkan`);
            return;
        }
    }

    if (ovpnFiles.length === 0) {
        console.warn('[VPN] Tidak ada .ovpn file ditemukan → VPN dinonaktifkan');
        return;
    }

    vpnEnabled = true;
    console.log(`[VPN] Aktif. ${ovpnFiles.length} ovpn config(s). Max ${MAX_ACCOUNTS_PER_NS} akun/namespace.`);
}

// Jalankan init saat module di-load
init();

// ── Helpers ───────────────────────────────────────────────────────────────────

function getOvpnConfig(nsIndex) {
    const file = ovpnFiles[nsIndex % ovpnFiles.length];
    return path.join(CONFIGS_DIR, file);
}

function nsExists(nsName) {
    try {
        const out = execSync('ip netns list', { encoding: 'utf8' });
        return out.split('\n').some(line => line.startsWith(nsName));
    } catch {
        return false;
    }
}

/**
 * Tunggu interface tun0 muncul di dalam namespace (max 30 detik)
 */
async function waitForTun(nsName, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const out = execSync(`ip netns exec ${nsName} ip addr`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            if (out.includes('tun0')) return true;
        } catch { /* ignore */ }
        await new Promise(r => setTimeout(r, 1500));
    }
    return false;
}

/**
 * Buat namespace baru, jalankan openVPN di dalamnya, tulis wrapper script.
 */
async function createNamespace(nsIndex) {
    const nsName = `ns_vpn_${nsIndex}`;
    const ovpnConfig = getOvpnConfig(nsIndex);

    if (!fs.existsSync(ovpnConfig)) {
        throw new Error(`[VPN] Config tidak ditemukan: ${ovpnConfig}`);
    }

    // Buat netns
    if (!nsExists(nsName)) {
        execSync(`ip netns add ${nsName}`);
        // Aktifkan loopback di dalam namespace
        execSync(`ip netns exec ${nsName} ip link set lo up`);
        console.log(`[VPN] Namespace ${nsName} dibuat`);
    }

    // Spawn openvpn di dalam namespace
    console.log(`[VPN] Menghubungkan ${nsName} via ${path.basename(ovpnConfig)}...`);
    const ovpnProc = spawn('ip', [
        'netns', 'exec', nsName,
        'openvpn',
        '--config', ovpnConfig,
        '--auth-user-pass', VPN_AUTH_FILE,
        '--daemon',
        '--log', `/tmp/vpn_${nsName}.log`,
    ], { detached: true, stdio: 'ignore' });
    ovpnProc.unref();

    // Tunggu tun0 up
    const connected = await waitForTun(nsName);
    if (!connected) {
        // Cleanup namespace kalau gagal connect
        try { execSync(`ip netns del ${nsName}`); } catch { /* ignore */ }
        throw new Error(`[VPN] ${nsName} gagal connect dalam 30 detik. Cek /tmp/vpn_${nsName}.log`);
    }
    console.log(`[VPN] ${nsName} terhubung ✓`);

    // Dapatkan path chromium dari playwright
    let chromiumPath;
    try {
        chromiumPath = require('playwright').chromium.executablePath();
    } catch {
        // Fallback ke chromium sistem
        chromiumPath = execSync('which chromium-browser || which chromium || which google-chrome', { encoding: 'utf8' }).trim();
    }

    // Tulis wrapper script agar Playwright launch di dalam namespace ini
    const wrapperPath = `/tmp/ns-chromium-${nsName}.sh`;
    const wrapperContent = `#!/bin/bash\nexec /usr/bin/nsenter --net=/var/run/netns/${nsName} "${chromiumPath}" "$@"\n`;
    fs.writeFileSync(wrapperPath, wrapperContent, { mode: 0o755 });
    console.log(`[VPN] Wrapper script: ${wrapperPath}`);

    // Simpan ke map (pid akan null karena --daemon, track via nsName saja)
    vpnNamespaces.set(nsName, {
        ovpnConfig,
        accountIds: [],
        pid: ovpnProc.pid || null,
        wrapperPath,
    });

    return nsName;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Dapatkan/buat namespace untuk akun ini.
 * Assignment deterministik berdasarkan urutan createdAt akun active.
 * Return null kalau VPN tidak aktif atau gagal (fallback ke proxy).
 */
async function getOrCreateNamespace(accountId) {
    if (!vpnEnabled) return null;

    try {
        const accountIdStr = accountId.toString();

        // Cek apakah akun ini sudah punya namespace di map
        for (const [nsName, ns] of vpnNamespaces) {
            if (ns.accountIds.includes(accountIdStr)) return nsName;
        }

        // Tentukan nsIndex berdasarkan urutan createdAt (deterministik)
        const allActive = await Account.find({ status: { $in: ['active', 'full'] } })
            .sort({ createdAt: 1 })
            .select('_id')
            .lean();

        const rank = allActive.findIndex(a => a._id.toString() === accountIdStr);
        if (rank === -1) {
            // Akun tidak ditemukan (mungkin baru, query ulang tanpa filter status)
            const allAccounts = await Account.find().sort({ createdAt: 1 }).select('_id').lean();
            const rank2 = allAccounts.findIndex(a => a._id.toString() === accountIdStr);
            if (rank2 === -1) return null;
            const nsIndex2 = Math.floor(rank2 / MAX_ACCOUNTS_PER_NS);
            return await _assignToNamespace(accountIdStr, nsIndex2);
        }

        const nsIndex = Math.floor(rank / MAX_ACCOUNTS_PER_NS);
        return await _assignToNamespace(accountIdStr, nsIndex);

    } catch (err) {
        console.warn('[VPN] getOrCreateNamespace error (fallback ke proxy):', err.message);
        return null;
    }
}

async function _assignToNamespace(accountIdStr, nsIndex) {
    const nsName = `ns_vpn_${nsIndex}`;

    if (!vpnNamespaces.has(nsName)) {
        await createNamespace(nsIndex);
    }

    const ns = vpnNamespaces.get(nsName);
    if (!ns.accountIds.includes(accountIdStr)) {
        ns.accountIds.push(accountIdStr);
    }

    // Update DB
    await Account.findByIdAndUpdate(accountIdStr, {
        vpnNamespace: nsName,
        vpnAssignedAt: new Date(),
    }).catch(() => { /* non-critical */ });

    return nsName;
}

/**
 * Lepas akun dari namespace-nya.
 * Kalau namespace kosong → kill openvpn + hapus namespace.
 * Dipanggil saat akun jadi 'full' atau 'error'.
 */
async function releaseAccount(accountId) {
    if (!vpnEnabled) return;

    const accountIdStr = accountId.toString();

    for (const [nsName, ns] of vpnNamespaces) {
        const idx = ns.accountIds.indexOf(accountIdStr);
        if (idx === -1) continue;

        ns.accountIds.splice(idx, 1);
        console.log(`[VPN] Akun ${accountIdStr} dilepas dari ${nsName} (sisa: ${ns.accountIds.length} akun)`);

        // Update DB
        await Account.findByIdAndUpdate(accountIdStr, {
            vpnNamespace: null,
            vpnAssignedAt: null,
        }).catch(() => { /* non-critical */ });

        // Kalau namespace kosong, cleanup
        if (ns.accountIds.length === 0) {
            console.log(`[VPN] ${nsName} kosong, melakukan cleanup...`);
            try {
                // Kill semua proses openvpn di dalam namespace
                try { execSync(`ip netns exec ${nsName} pkill openvpn`, { stdio: 'ignore' }); } catch { /* ok */ }
                await new Promise(r => setTimeout(r, 2000));
                // Hapus namespace
                execSync(`ip netns del ${nsName}`);
                console.log(`[VPN] Namespace ${nsName} dihapus ✓`);
            } catch (err) {
                console.warn(`[VPN] Gagal cleanup ${nsName}:`, err.message);
            }
            // Hapus wrapper script
            try { fs.unlinkSync(ns.wrapperPath); } catch { /* ok */ }
            vpnNamespaces.delete(nsName);
        }
        return;
    }
}

/**
 * Dapatkan path wrapper script untuk namespace ini.
 * Return null kalau tidak ada / belum dibuat.
 */
function getWrapperPath(nsName) {
    if (!nsName) return null;
    const wrapperPath = `/tmp/ns-chromium-${nsName}.sh`;
    return fs.existsSync(wrapperPath) ? wrapperPath : null;
}

module.exports = { getOrCreateNamespace, releaseAccount, getWrapperPath };
