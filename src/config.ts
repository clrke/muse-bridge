import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Loopback only: both families, since `localhost` may resolve to ::1 first. */
export const DEFAULT_HOSTS = ['127.0.0.1', '::1'];
export const DEFAULT_PORT = 3141;

/** How agent sessions run: one-shot `muse exec` children, or supervised `muse serve` hosts. */
export type SessionDriverKind = 'exec' | 'serve';

export interface Config {
  port: number;
  /** Interfaces to listen on. Default: loopback only. */
  hosts: string[];
  /** Bearer token required on every route except /health. Unset = no auth (loopback only!). */
  token: string | undefined;
  /** Browser origins allowed to call the bridge. Default: none (requests with an Origin header are refused). */
  allowedOrigins: string[];
  /** The `muse` executable. */
  musePath: string;
  /** Bridge state directory (usage snapshot, default projects dir). */
  homeDir: string;
  /** One `<slug>.md` file per project. */
  projectsDir: string;
  /** Sender name used when a client omits `trigger.sender`. */
  senderName: string;
  maxRequestsPerMinute: number;
  /** Cap on one cron-triggered auto-decide turn. */
  autoDecideTimeoutMs: number;
  /** Run the hourly auto-decide cron. */
  cron: boolean;
  /** Secret-looking variables to pass to `muse` anyway (see cleanEnv in session-manager). */
  envPassthrough: string[];
  /** Verbose tracing: comma-separated scopes, or '1' for all. */
  debug: string;
  /** LAN pairing: also listen on private LAN addresses, guarded by the pairing token, and show a QR code. */
  pair: boolean;
  /** Rotate the stored pairing token at startup (`--reset-pairing`), unpairing every device. */
  resetPairing: boolean;
  /** Discover recently edited projects at startup and suggest them (GET /suggestions). */
  discover: boolean;
  /** Folders to scan for projects. Empty: the usual code folders under the home directory. */
  scanRoots: string[];
  /** Session driver. Anything but 'serve' falls back to 'exec'. */
  driver: SessionDriverKind;
}

const list = (s: string | undefined): string[] =>
  (s ?? '').split(',').map(x => x.trim()).filter(Boolean);

const off = (s: string | undefined) => s === '0' || s === 'false' || s === 'off' || s === 'no';

/** Comma- or colon-separated paths (a colon list like PATH works too). */
export const pathList = (s: string | undefined): string[] =>
  (s ?? '').split(/[,:]/).map(x => x.trim()).filter(Boolean);

const int = (s: string | undefined, fallback: number): number => {
  const n = Number.parseInt(s ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

const expandHome = (p: string): string =>
  p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;

/** `MUSE_PATH`, else the installer's default location if present, else `muse` on PATH. */
export function defaultMusePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MUSE_PATH) return expandHome(env.MUSE_PATH);
  const local = path.join(os.homedir(), '.local', 'bin', 'muse');
  try {
    fs.accessSync(local, fs.constants.X_OK);
    return local;
  } catch {
    return 'muse';
  }
}

/** Build the config from environment variables, then apply explicit overrides (CLI flags). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const homeDir = path.resolve(expandHome(overrides.homeDir ?? env.MUSE_BRIDGE_HOME ?? path.join(os.homedir(), '.muse-bridge')));
  const projectsDir = path.resolve(expandHome(overrides.projectsDir ?? env.MUSE_BRIDGE_PROJECTS_DIR ?? path.join(homeDir, 'projects')));
  const hosts = list(env.BRIDGE_HOSTS);
  const base: Config = {
    port: int(env.PORT, DEFAULT_PORT),
    hosts: hosts.length ? hosts : [...DEFAULT_HOSTS],
    token: env.BRIDGE_TOKEN || undefined,
    allowedOrigins: list(env.BRIDGE_ORIGINS),
    musePath: defaultMusePath(env),
    homeDir,
    projectsDir,
    senderName: env.MUSE_BRIDGE_SENDER || 'user',
    maxRequestsPerMinute: int(env.MAX_RPM, 60),
    autoDecideTimeoutMs: int(env.AUTO_DECIDE_TIMEOUT_MS, 60 * 60 * 1000),
    cron: env.MUSE_BRIDGE_CRON !== '0' && env.MUSE_BRIDGE_CRON !== 'false',
    envPassthrough: list(env.MUSE_ENV_PASSTHROUGH),
    debug: env.DEBUG ?? '',
    pair: !off(env.MUSE_BRIDGE_PAIR),
    resetPairing: false,
    discover: !off(env.MUSE_BRIDGE_DISCOVER),
    scanRoots: pathList(env.MUSE_BRIDGE_SCAN_ROOTS).map(expandHome),
    driver: env.MUSE_BRIDGE_DRIVER === 'serve' ? 'serve' : 'exec',
  };
  const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  if (overrides.scanRoots) defined.scanRoots = overrides.scanRoots.map(expandHome);
  return { ...base, ...defined, homeDir, projectsDir };
}

/** True for addresses that only this machine can reach. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}
