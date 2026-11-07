import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, isLoopbackHost, DEFAULT_HOSTS } from '../src/config.js';
import { parseCliArgs } from '../src/cli.js';
import { assertSafeExposure } from '../src/server.js';

describe('loadConfig', () => {
  it('defaults to loopback on 3141 with state under ~/.muse-bridge', () => {
    const c = loadConfig({ MUSE_PATH: '/x/muse' });
    expect(c.port).toBe(3141);
    expect(c.hosts).toEqual(DEFAULT_HOSTS);
    expect(c.token).toBeUndefined();
    expect(c.homeDir).toBe(path.join(os.homedir(), '.muse-bridge'));
    expect(c.projectsDir).toBe(path.join(os.homedir(), '.muse-bridge', 'projects'));
    expect(c.musePath).toBe('/x/muse');
    expect(c.senderName).toBe('user');
    expect(c.cron).toBe(true);
  });

  it('reads env, and flags override env', () => {
    const env = { PORT: '4000', BRIDGE_HOSTS: '127.0.0.1, 10.0.0.2', BRIDGE_TOKEN: 't', MUSE_BRIDGE_HOME: '/srv/mb', MUSE_BRIDGE_SENDER: 'pilot', MUSE_BRIDGE_CRON: '0', MUSE_ENV_PASSTHROUGH: 'GH_TOKEN' };
    const c = loadConfig(env);
    expect(c).toMatchObject({ port: 4000, hosts: ['127.0.0.1', '10.0.0.2'], token: 't', homeDir: '/srv/mb', projectsDir: '/srv/mb/projects', senderName: 'pilot', cron: false, envPassthrough: ['GH_TOKEN'] });
    const o = loadConfig(env, parseCliArgs(['-p', '5000', '--host', '::1', '--projects-dir', '~/p', '--sender', 'me']).overrides);
    expect(o).toMatchObject({ port: 5000, hosts: ['::1'], projectsDir: path.join(os.homedir(), 'p'), senderName: 'me' });
  });
});

describe('pairing and discovery config', () => {
  it('defaults pairing and discovery on, with no explicit scan roots', () => {
    expect(loadConfig({})).toMatchObject({ pair: true, resetPairing: false, discover: true, scanRoots: [] });
  });
  it('reads MUSE_BRIDGE_PAIR / _DISCOVER / _SCAN_ROOTS, and flags win', () => {
    const env = { MUSE_BRIDGE_PAIR: '0', MUSE_BRIDGE_DISCOVER: 'false', MUSE_BRIDGE_SCAN_ROOTS: '~/code:/srv/repos,/opt/w' };
    expect(loadConfig(env)).toMatchObject({ pair: false, discover: false, scanRoots: [path.join(os.homedir(), 'code'), '/srv/repos', '/opt/w'] });
    const o = parseCliArgs(['--no-pair', '--reset-pairing', '--no-discover', '--scan-root', '~/a', '--scan-root', '/b,/c']).overrides;
    expect(o).toEqual({ pair: false, resetPairing: true, discover: false, scanRoots: ['~/a', '/b', '/c'] });
    expect(loadConfig({}, o).scanRoots).toEqual([path.join(os.homedir(), 'a'), '/b', '/c']);
  });
});

describe('parseCliArgs', () => {
  it('parses flags and rejects unknown ones', () => {
    expect(parseCliArgs(['--no-cron', '-H', '127.0.0.1,::1']).overrides).toEqual({ cron: false, hosts: ['127.0.0.1', '::1'] });
    expect(parseCliArgs(['--help']).help).toBe(true);
    expect(() => parseCliArgs(['--port', 'abc'])).toThrow(/Invalid --port/);
    expect(() => parseCliArgs(['--bogus'])).toThrow();
  });
});

describe('exposure guard', () => {
  it('knows loopback addresses', () => {
    expect(['127.0.0.1', '127.1.2.3', '::1', '[::1]', 'localhost'].every(isLoopbackHost)).toBe(true);
    expect(['0.0.0.0', '::', '192.168.1.5'].some(isLoopbackHost)).toBe(false);
  });
  it('refuses a non-loopback host without a token', () => {
    expect(() => assertSafeExposure({ hosts: DEFAULT_HOSTS, token: undefined })).not.toThrow();
    expect(() => assertSafeExposure({ hosts: ['0.0.0.0'], token: undefined })).toThrow(/BRIDGE_TOKEN/);
    expect(() => assertSafeExposure({ hosts: ['0.0.0.0'], token: 'x' })).not.toThrow();
  });
});
