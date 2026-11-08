/**
 * LAN pairing: a long-lived random token, the private LAN addresses the bridge also listens on
 * when pairing is on, and the QR code a headset scans to connect.
 *
 * QR payload: `musebridge://pair?u=<url>[&u=<url>…]&t=<token>&n=<hostname>`, one `u` per LAN
 * address (best first), every value URL-encoded.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';

export const PAIRING_FILE = 'pairing.json';

/** Shown under the QR code, in the terminal and on GET /pair. */
export const PAIR_CAPTION =
  'Scan with Agent Huddle on your Quest to connect (same Wi-Fi). Pairing token stays on this machine; ' +
  'anyone who scans this code can run agents as you.';

/** A fresh 128-bit token, base64url (22 chars). */
export function newPairingToken(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * The pairing token: `fixed` (BRIDGE_TOKEN) when set, else the one stored in
 * `<homeDir>/pairing.json` (created with mode 0600 on first use, rotated by `reset`).
 */
export function loadPairingToken(homeDir: string, opts: { reset?: boolean; fixed?: string } = {}): { token: string; created: boolean } {
  if (opts.fixed) return { token: opts.fixed, created: false };
  const file = path.join(homeDir, PAIRING_FILE);
  if (!opts.reset) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (typeof j?.token === 'string' && /^[A-Za-z0-9_-]{16,}$/.test(j.token)) {
        try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
        return { token: j.token, created: false };
      }
    } catch { /* missing or unreadable: make a new one */ }
  }
  const token = newPairingToken();
  fs.mkdirSync(homeDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ token, createdAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return { token, created: true };
}

/** RFC 1918 private IPv4: 10/8, 172.16/12, 192.168/16. */
export function isPrivateIPv4(addr: string): boolean {
  const m = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some(n => n > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** True for a socket's remote address that only this machine can be (`127.x`, `::1`, `::ffff:127.x`). */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase().replace(/^::ffff:/, '');
  return a === '::1' || /^127\.\d+\.\d+\.\d+$/.test(a);
}

/** Tunnels, VPNs, container and VM bridges, Apple peer-to-peer links: never a headset's Wi-Fi. */
const VIRTUAL_IFACE_RE = /^(?:utun|tun|tap|ppp|ipsec|wg|tailscale|zt|docker|br-|veth|virbr|vboxnet|vmnet|vnic|bridge|awdl|llw|gif|stf|anpi|ap\d|feth)/i;

export interface LanAddress { iface: string; address: string }

/** Interface rank: the usual primary Wi-Fi / Ethernet names first. */
function ifaceRank(name: string): number {
  if (/^(?:en0|eth0|wlan0|wlp\w*|wlo\d*|Wi-?Fi)$/i.test(name)) return 0;
  if (/^(?:en|eth|wlan|wl|Ethernet)/i.test(name)) return 1;
  return 2;
}

/**
 * The private LAN IPv4 addresses worth listening on and advertising, best first. Skips internal,
 * link-local (169.254/16, not RFC 1918 anyway) and VPN/virtual interfaces.
 */
export function lanAddresses(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): LanAddress[] {
  const out: (LanAddress & { rank: number; order: number })[] = [];
  let order = 0;
  for (const [iface, infos] of Object.entries(interfaces)) {
    if (!infos || VIRTUAL_IFACE_RE.test(iface)) continue;
    for (const info of infos) {
      const family = info.family as unknown;
      if ((family !== 'IPv4' && family !== 4) || info.internal || !isPrivateIPv4(info.address)) continue;
      if (out.some(o => o.address === info.address)) continue;
      out.push({ iface, address: info.address, rank: ifaceRank(iface), order: order++ });
    }
  }
  return out.sort((a, b) => a.rank - b.rank || a.order - b.order).map(({ iface, address }) => ({ iface, address }));
}

/** `my-mac.local` → `my-mac`. */
export function shortHostname(name: string = os.hostname()): string {
  return name.split('.')[0] || name;
}

export interface PairInfo {
  payload: string;
  urls: string[];
  hostname: string;
}

/** The QR payload for these base URLs (best first). */
export function pairingPayload(urls: string[], token: string, hostname: string): string {
  const q = [...urls.map(u => `u=${encodeURIComponent(u)}`), `t=${encodeURIComponent(token)}`, `n=${encodeURIComponent(hostname)}`];
  return `musebridge://pair?${q.join('&')}`;
}

export function pairInfo(addresses: LanAddress[], port: number, token: string, hostname = shortHostname()): PairInfo {
  const urls = addresses.map(a => `http://${a.address}:${port}`);
  return { payload: pairingPayload(urls, token, hostname), urls, hostname };
}

/** Error correction for every rendering: M survives a slightly blurry headset camera and still fits version ≤ 10. */
const QR_OPTS = { errorCorrectionLevel: 'M' as const };

/** The QR version (size) the payload needs. */
export function qrVersion(payload: string): number {
  return QRCode.create(payload, QR_OPTS).version;
}

/**
 * The QR for a terminal. On a TTY: ANSI black-on-white half blocks, readable on dark and light
 * themes. Otherwise plain UTF-8 blocks (dark modules as `█`).
 */
export function renderTerminalQr(payload: string, tty: boolean): Promise<string> {
  return tty
    ? QRCode.toString(payload, { ...QR_OPTS, type: 'terminal', small: true })
    : QRCode.toString(payload, { ...QR_OPTS, type: 'utf8', margin: 2 });
}

export function renderSvgQr(payload: string): Promise<string> {
  return QRCode.toString(payload, { ...QR_OPTS, type: 'svg', margin: 2 });
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** The GET /pair page: the QR as inline SVG, the caption and the addresses. */
export function pairPageHtml(svg: string, info: PairInfo): string {
  const urls = info.urls.map(u => `<li><code>${esc(u)}</code></li>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair with muse-bridge on ${esc(info.hostname)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;color:#222}
.qr{background:#fff;padding:1rem;width:20rem;max-width:100%}.qr svg{width:100%;height:auto;display:block}
p{line-height:1.4}code{font-size:.9em}</style></head>
<body><h1>Pair with ${esc(info.hostname)}</h1>
<div class="qr">${svg}</div>
<p>${esc(PAIR_CAPTION)}</p>
<p>Bridge addresses:</p><ul>${urls}</ul>
<p>Run <code>muse-bridge --reset-pairing</code> to unpair every device, or <code>--no-pair</code> to stay on loopback.</p>
</body></html>
`;
}
