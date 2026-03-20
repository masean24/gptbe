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
 * Dapatkan nama interface default host (eth0, ens3, dst)
 */
function getDefaultIface() {
    try {
        const out = execSync("ip route show default | awk '{print $5}' | head -1", { encoding: 'utf8' }).trim();
        return out || 'eth0';
    } catch {
        return 'eth0';
    }
}

/**
 * Buat namespace baru dengan akses internet via veth pair + NAT,
 * jalankan openVPN di dalamnya, tulis wrapper script.
 */
async function createNamespace(nsIndex) {
    const nsName = `ns_vpn_${nsIndex}`;
    const ovpnConfig = getOvpnConfig(nsIndex);

    if (!fs.existsSync(ovpnConfig)) {
        throw new Error(`[VPN] Config tidak ditemukan: ${ovpnConfig}`);
    }

    // IP untuk veth pair — tiap namespace pakai subnet /30 sendiri
    // ns_vpn_0: 10.200.0.1 (host) <-> 10.200.0.2 (ns)
    // ns_vpn_1: 10.200.1.1 (host) <-> 10.200.1.2 (ns)
    const hostVethIp = `10.200.${nsIndex}.1`;
    const nsVethIp   = `10.200.${nsIndex}.2`;
    const vethHost   = `veth_h${nsIndex}`; // max 15 char
    const vethNs     = `veth_n${nsIndex}`;
    const defaultIface = getDefaultIface();

    // Buat netns
    if (!nsExists(nsName)) {
        execSync(`ip netns add ${nsName}`);
        execSync(`ip netns exec ${nsName} ip link set lo up`);
        console.log(`[VPN] Namespace ${nsName} dibuat`);
    }

    // Setup veth pair: host <-> namespace
    // Hapus dulu kalau ada sisa dari run sebelumnya
    try { execSync(`ip link del ${vethHost}`, { stdio: 'ignore' }); } catch { /* ok */ }
    execSync(`ip link add ${vethHost} type veth peer name ${vethNs}`);
    execSync(`ip link set ${vethNs} netns ${nsName}`);
    execSync(`ip addr add ${hostVethIp}/30 dev ${vethHost}`);
    execSync(`ip link set ${vethHost} up`);
    execSync(`ip netns exec ${nsName} ip addr add ${nsVethIp}/30 dev ${vethNs}`);
    execSync(`ip netns exec ${nsName} ip link set ${vethNs} up`);
    execSync(`ip netns exec ${nsName} ip route add default via ${hostVethIp}`);
    console.log(`[VPN] veth pair: ${vethHost}(${hostVethIp}) <-> ${vethNs}(${nsVethIp})`);

    // DNS untuk namespace via /etc/netns/<nsName>/resolv.conf
    execSync(`mkdir -p /etc/netns/${nsName}`);
    fs.writeFileSync(`/etc/netns/${nsName}/resolv.conf`, 'nameserver 8.8.8.8\nnameserver 8.8.4.4\n');

    // Aktifkan IP forwarding dan NAT di host
    execSync(`sysctl -w net.ipv4.ip_forward=1`, { stdio: 'ignore' });
    // Hapus rule lama dulu (idempotent), lalu tambah
    try { execSync(`iptables -t nat -D POSTROUTING -s ${nsVethIp}/32 -o ${defaultIface} -j MASQUERADE`, { stdio: 'ignore' }); } catch { /* ok */ }
    execSync(`iptables -t nat -A POSTROUTING -s ${nsVethIp}/32 -o ${defaultIface} -j MASQUERADE`);

    // FORWARD rules — tanpa ini traffic dari namespace TIDAK bisa keluar
    try { execSync(`iptables -D FORWARD -i ${vethHost} -o ${defaultIface} -j ACCEPT`, { stdio: 'ignore' }); } catch { /* ok */ }
    try { execSync(`iptables -D FORWARD -i ${defaultIface} -o ${vethHost} -m state --state RELATED,ESTABLISHED -j ACCEPT`, { stdio: 'ignore' }); } catch { /* ok */ }
    execSync(`iptables -A FORWARD -i ${vethHost} -o ${defaultIface} -j ACCEPT`);
    execSync(`iptables -A FORWARD -i ${defaultIface} -o ${vethHost} -m state --state RELATED,ESTABLISHED -j ACCEPT`);
    console.log(`[VPN] NAT + FORWARD aktif: ${nsVethIp} -> ${defaultIface}`);

    // Pre-resolve hostname VPN di HOST agar openvpn tidak perlu DNS di dalam namespace
    // (namespace baru isolasi network-nya terpisah, DNS mungkin belum reliable saat pertama konek)
    let extraArgs = [];
    try {
        const ovpnContent = fs.readFileSync(ovpnConfig, 'utf8');
        const remoteMatch = ovpnContent.match(/^remote\s+(\S+)\s+(\d+)/m);
        if (remoteMatch) {
            const hostname = remoteMatch[1];
            const port = remoteMatch[2];
            // Kalau sudah berupa IP, skip resolve
            if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
                const resolved = execSync(
                    `getent hosts ${hostname} | awk '{print $1}' | head -1`,
                    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
                ).trim();
                if (resolved) {
                    extraArgs = ['--remote', resolved, port, '--remote-cert-tls', 'server'];
                    console.log(`[VPN] Pre-resolved ${hostname} → ${resolved}`);
                }
            }
        }
    } catch (e) {
        console.warn('[VPN] Pre-resolve gagal, openvpn akan resolve sendiri:', e.message);
    }

    // Spawn openvpn di dalam namespace
    console.log(`[VPN] Menghubungkan ${nsName} via ${path.basename(ovpnConfig)}...`);
    const ovpnArgs = [
        'netns', 'exec', nsName,
        'openvpn',
        '--config', ovpnConfig,
        '--auth-user-pass', VPN_AUTH_FILE,
        '--daemon',
        '--log', `/tmp/vpn_${nsName}.log`,
        ...extraArgs,
    ];
    const ovpnProc = spawn('ip', ovpnArgs, { detached: true, stdio: 'ignore' });
    ovpnProc.unref();

    // Tunggu tun0 up (max 60 detik)
    const connected = await waitForTun(nsName, 60000);
    if (!connected) {
        // Cleanup — termasuk FORWARD rules
        try { execSync(`iptables -t nat -D POSTROUTING -s ${nsVethIp}/32 -o ${defaultIface} -j MASQUERADE`, { stdio: 'ignore' }); } catch { /* ok */ }
        try { execSync(`iptables -D FORWARD -i ${vethHost} -o ${defaultIface} -j ACCEPT`, { stdio: 'ignore' }); } catch { /* ok */ }
        try { execSync(`iptables -D FORWARD -i ${defaultIface} -o ${vethHost} -m state --state RELATED,ESTABLISHED -j ACCEPT`, { stdio: 'ignore' }); } catch { /* ok */ }
        try { execSync(`ip link del ${vethHost}`, { stdio: 'ignore' }); } catch { /* ok */ }
        try { execSync(`ip netns del ${nsName}`); } catch { /* ok */ }
        try { execSync(`rm -rf /etc/netns/${nsName}`); } catch { /* ok */ }
        throw new Error(`[VPN] ${nsName} gagal connect dalam 60 detik. Cek /tmp/vpn_${nsName}.log`);
    }
    console.log(`[VPN] ${nsName} terhubung ✓`);

    // Dapatkan path chromium dari playwright
    let chromiumPath;
    try {
        chromiumPath = require('playwright').chromium.executablePath();
    } catch {
        chromiumPath = execSync('which chromium-browser || which chromium || which google-chrome', { encoding: 'utf8' }).trim();
    }

    // Tulis wrapper script agar Playwright launch di dalam namespace ini
    const wrapperPath = `/tmp/ns-chromium-${nsName}.sh`;
    const wrapperContent = `#!/bin/bash\nexec ip netns exec ${nsName} "${chromiumPath}" "$@"\n`;
    fs.writeFileSync(wrapperPath, wrapperContent, { mode: 0o755 });
    console.log(`[VPN] Wrapper script: ${wrapperPath}`);

    vpnNamespaces.set(nsName, {
        ovpnConfig,
        accountIds: [],
        pid: ovpnProc.pid || null,
        wrapperPath,
        vethHost,
        nsVethIp,
        defaultIface,
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
                try { execSync(`ip netns exec ${nsName} pkill openvpn`, { stdio: 'ignore' }); } catch { /* ok */ }
                await new Promise(r => setTimeout(r, 2000));
                // Hapus iptables NAT + FORWARD rules
                try { execSync(`iptables -t nat -D POSTROUTING -s ${ns.nsVethIp}/32 -o ${ns.defaultIface} -j MASQUERADE`, { stdio: 'ignore' }); } catch { /* ok */ }
                try { execSync(`iptables -D FORWARD -i ${ns.vethHost} -o ${ns.defaultIface} -j ACCEPT`, { stdio: 'ignore' }); } catch { /* ok */ }
                try { execSync(`iptables -D FORWARD -i ${ns.defaultIface} -o ${ns.vethHost} -m state --state RELATED,ESTABLISHED -j ACCEPT`, { stdio: 'ignore' }); } catch { /* ok */ }
                // Hapus veth pair (otomatis hapus pasangannya juga)
                try { execSync(`ip link del ${ns.vethHost}`, { stdio: 'ignore' }); } catch { /* ok */ }
                // Hapus namespace
                execSync(`ip netns del ${nsName}`);
                // Hapus DNS config
                try { execSync(`rm -rf /etc/netns/${nsName}`); } catch { /* ok */ }
                console.log(`[VPN] Namespace ${nsName} dihapus ✓`);
            } catch (err) {
                console.warn(`[VPN] Gagal cleanup ${nsName}:`, err.message);
            }
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
