import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isLoopbackAddress, isPrivateIPv4, lanAddresses, loadPairingToken, newPairingToken, pairInfo, pairingPayload,
  pairPageHtml, qrVersion, renderSvgQr, renderTerminalQr, shortHostname, PAIR_CAPTION,
} from '../src/pairing.js';
import { pairListenAddresses, startServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const iface = (address: string, extra: Partial<os.NetworkInterfaceInfo> = {}) =>
  ({ address, family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null, ...extra }) as os.NetworkInterfaceInfo;

describe('pairing token', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-bridge-pair-')); });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('is 128 random bits, base64url', () => {
    const t = newPairingToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(t, 'base64url')).toHaveLength(16);
    expect(newPairingToken()).not.toBe(t);
  });

  it('is created once in pairing.json (mode 0600) and kept across restarts', () => {
    const a = loadPairingToken(home);
    expect(a.created).toBe(true);
    const file = path.join(home, 'pairing.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toMatchObject({ token: a.token, createdAt: expect.any(String) });
    const b = loadPairingToken(home);
    expect(b).toEqual({ token: a.token, created: false });
  });

  it('rotates on reset, and replaces a corrupt file', () => {
    const a = loadPairingToken(home);
    const b = loadPairingToken(home, { reset: true });
    expect(b.token).not.toBe(a.token);
    expect(loadPairingToken(home).token).toBe(b.token);
    fs.writeFileSync(path.join(home, 'pairing.json'), '{not json');
    const c = loadPairingToken(home);
    expect(c.created).toBe(true);
    expect(c.token).not.toBe(b.token);
  });

  it('uses BRIDGE_TOKEN as is, without touching the file', () => {
    expect(loadPairingToken(home, { fixed: 'env-token', reset: true })).toEqual({ token: 'env-token', created: false });
    expect(fs.existsSync(path.join(home, 'pairing.json'))).toBe(false);
  });
});

describe('addresses', () => {
  it('knows RFC 1918 and loopback', () => {
    expect(['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.20'].every(isPrivateIPv4)).toBe(true);
    expect(['172.15.0.1', '172.32.0.1', '169.254.1.1', '8.8.8.8', '192.169.0.1', '100.64.0.1', '10.0.0.256', 'fe80::1'].some(isPrivateIPv4)).toBe(false);
    expect(['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.9.9.9'].every(isLoopbackAddress)).toBe(true);
    expect(['192.168.1.5', '::ffff:192.168.1.5', '', undefined].some(isLoopbackAddress)).toBe(false);
  });

  it('keeps private IPv4 on real interfaces, primary Wi-Fi/Ethernet first', () => {
    const lan = lanAddresses({
      lo0: [iface('127.0.0.1', { internal: true })],
      bridge100: [iface('192.168.64.1')],
      utun3: [iface('10.8.0.2')],
      feth100: [iface('10.243.0.5')],
      docker0: [iface('172.17.0.1')],
      en5: [iface('10.0.1.7')],
      en0: [iface('fe80::1', { family: 'IPv6' }), iface('192.168.1.20'), iface('169.254.3.3')],
      awdl0: [iface('192.168.200.1')],
      en7: [iface('203.0.113.9')],
    });
    expect(lan).toEqual([{ iface: 'en0', address: '192.168.1.20' }, { iface: 'en5', address: '10.0.1.7' }]);
    expect(lanAddresses({ wlan0: [iface('192.168.0.9', { family: 4 as unknown as 'IPv4' })] })).toEqual([{ iface: 'wlan0', address: '192.168.0.9' }]);
    expect(lanAddresses({})).toEqual([]);
  });

  it('adds no listener a configured host already covers', () => {
    const lan = [{ iface: 'en0', address: '192.168.1.20' }, { iface: 'en5', address: '10.0.1.7' }];
    expect(pairListenAddresses(['127.0.0.1', '::1'], lan)).toEqual(lan);
    expect(pairListenAddresses(['127.0.0.1', '10.0.1.7'], lan)).toEqual([lan[0]]);
  });
});

describe('QR payload', () => {
  const token = 'MxxWSzS20Bkhiqj_k0xqRw';

  it('has one u= per address (best first), the token and the short hostname, URL-encoded', () => {
    const info = pairInfo([{ iface: 'en0', address: '192.168.1.20' }, { iface: 'en5', address: '10.0.1.7' }], 3141, token, 'my-mac');
    expect(info.urls).toEqual(['http://192.168.1.20:3141', 'http://10.0.1.7:3141']);
    expect(info.payload).toBe(`musebridge://pair?u=http%3A%2F%2F192.168.1.20%3A3141&u=http%3A%2F%2F10.0.1.7%3A3141&t=${token}&n=my-mac`);
    const u = new URL(info.payload);
    expect(u.protocol).toBe('musebridge:');
    expect(u.searchParams.getAll('u')).toEqual(info.urls);
    expect(u.searchParams.get('t')).toBe(token);
    expect(pairingPayload(['http://10.0.0.2:1'], 'a', 'Jo’s Mac')).toBe('musebridge://pair?u=http%3A%2F%2F10.0.0.2%3A1&t=a&n=Jo%E2%80%99s%20Mac');
    expect(shortHostname('my-mac.local')).toBe('my-mac');
  });

  it('fits QR version 10 or less for a typical machine (two addresses, long hostname)', () => {
    const info = pairInfo([{ iface: 'en0', address: '192.168.100.146' }, { iface: 'en5', address: '172.20.130.250' }], 65535, newPairingToken(), 'Someones-MacBook-Pro-2');
    expect(qrVersion(info.payload)).toBeLessThanOrEqual(10);
    expect(qrVersion(pairInfo([{ iface: 'en0', address: '192.168.1.20' }], 3141, token, 'my-mac').payload)).toBeLessThanOrEqual(5);
  });

  it('renders for a terminal and as an SVG page with the caption', async () => {
    const payload = pairingPayload(['http://192.168.1.20:3141'], token, 'my-mac');
    expect(await renderTerminalQr(payload, false)).toMatch(/[█▀▄]/);
    expect(await renderTerminalQr(payload, true)).toContain('\x1b[');
    const svg = await renderSvgQr(payload);
    expect(svg).toMatch(/^<svg/);
    const html = pairPageHtml(svg, { payload, urls: ['http://192.168.1.20:3141'], hostname: '<my-mac>' });
    expect(html).toContain(svg);
    expect(html).toContain('&lt;my-mac&gt;');
    expect(html).toContain('Scan with Monkey Agents on your Quest');
    expect(PAIR_CAPTION).toMatch(/anyone who scans this code can run agents as you/);
  });
});

describe('startServer with pairing', () => {
  it('creates the token, survives a LAN address it cannot bind, and keeps loopback working', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-bridge-start-'));
    const out: string[] = [];
    const log = console.log, warn = console.warn;
    console.log = console.warn = () => {};
    try {
      const config = loadConfig({ MUSE_PATH: '/nonexistent/muse' }, { homeDir: home, port: 0, hosts: ['127.0.0.1'], cron: false, discover: false });
      // An address that is not on this machine: EADDRNOTAVAIL, skipped.
      const bridge = await startServer(config, { interfaces: { en0: [iface('192.168.254.253')] }, out: t => out.push(t) });
      try {
        expect(bridge.servers).toHaveLength(1);
        expect(fs.existsSync(path.join(home, 'pairing.json'))).toBe(true);
        const port = (bridge.servers[0].address() as { port: number }).port;
        const res = await fetch(`http://127.0.0.1:${port}/pair.json`, { headers: { Host: `localhost:${port}` } });
        expect(res.status).toBe(404); // no LAN listener came up, so nothing to pair over
        expect((await fetch(`http://127.0.0.1:${port}/suggestions`).then(r => r.json())).enabled).toBe(false);
      } finally {
        await bridge.close(10);
      }
    } finally {
      console.log = log; console.warn = warn;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
