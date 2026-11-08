import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { isLoopbackHost, type Config } from './config.js';
import { createApp, wireBridgeEvents, type SseResponse } from './app.js';
import { ONE_SHOT_KEY } from './session-manager.js';
import { createSessionDriver } from './serve-sessions.js';
import { lanAddresses, loadPairingToken, pairInfo, PAIR_CAPTION, renderTerminalQr, type LanAddress, type PairInfo } from './pairing.js';
import { resolveScanRoots, scanProjects } from './discovery.js';
import { Suggestions, type SuggestionsSnapshot } from './suggestions.js';
import { ProjectStore } from './project-store.js';
import { CommandRouter } from './command-router.js';
import { startCronJobs } from './cron.js';
import { persistMuseUsage, pollMuseAllowance } from './muse-usage.js';
import { Feed } from './feed.js';
import { RunJournal } from './run-journal.js';

export interface RunningBridge {
  servers: Server[];
  /** Release the port(s), then wait (up to `drainMs`) for running turns to finish. */
  close(drainMs?: number): Promise<boolean>;
}

/**
 * Refuse a configuration that would expose agents (which run with every action pre-approved)
 * beyond this machine without a token.
 */
export function assertSafeExposure(config: Pick<Config, 'hosts' | 'token'>): void {
  const exposed = config.hosts.filter(h => !isLoopbackHost(h));
  if (exposed.length > 0 && !config.token) {
    throw new Error(
      `Refusing to listen on ${exposed.join(', ')} without BRIDGE_TOKEN: anything that can reach the bridge can run ` +
      'shell commands as you. Set BRIDGE_TOKEN (and put TLS in front), or keep the default loopback hosts.',
    );
  }
}

/** Hosts that already cover every IPv4 address, so separate LAN listeners would clash. */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]']);

/** LAN addresses to add listeners for: none if a configured host already covers them. */
export function pairListenAddresses(hosts: string[], lan: LanAddress[]): LanAddress[] {
  if (hosts.some(h => WILDCARD_HOSTS.has(h))) return lan;
  return lan.filter(a => !hosts.includes(a.address));
}

const MUSE_RANK_TIMEOUT_MS = 90_000;

export interface StartOptions {
  /** Network interfaces (tests). Default: os.networkInterfaces(). */
  interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  /** Where startup notes and the QR go. Default: stdout. */
  out?: (text: string) => void;
}

export async function startServer(config: Config, opts: StartOptions = {}): Promise<RunningBridge> {
  assertSafeExposure(config);
  fs.mkdirSync(config.homeDir, { recursive: true });
  const out = opts.out ?? ((t: string) => { process.stdout.write(t.endsWith('\n') ? t : `${t}\n`); });

  const projectStore = new ProjectStore(config.projectsDir);
  const sessionManager = createSessionDriver(config.driver, config);
  console.log(`[Bridge] Session driver: ${config.driver === 'serve' ? 'serve (supervised hosts, approvals to /feed)' : 'exec (one-shot muse exec --yolo)'}`);
  const commandRouter = new CommandRouter(sessionManager, projectStore);
  const sseClients = new Set<SseResponse>();
  await projectStore.init();

  // Resume each project's stored Muse session. A project with no sessionId starts fresh.
  const projects = await projectStore.loadAll();
  for (const p of projects) {
    if (p.sessionId) sessionManager.loadSession(p.slug, p.sessionId);
  }

  persistMuseUsage(path.join(config.homeDir, 'muse-usage.json'));
  const usagePoll = setInterval(() => { void pollMuseAllowance(config.musePath); }, 10 * 60_000);
  usagePoll.unref();

  const broadcast = (text: string, slug?: string, projectDirectory?: string) => {
    const data = JSON.stringify({ type: 'message', text, slug: slug ?? null, projectDirectory: projectDirectory ?? null });
    for (const client of sseClients) client.write(`data: ${data}\n\n`);
    console.log(`[Bridge] broadcast ${slug ?? 'global'} -> ${sseClients.size} client(s) (${text.length} chars)`);
  };

  // One feed and one run journal shared by the HTTP routes and the cron, so GET /feed and
  // GET /runs/:id/events see every run.
  const feed = new Feed();
  const runJournal = new RunJournal();

  // Pairing: the token exists before any listener, so a LAN request is never unguarded.
  let pairing: { token: string; info: () => PairInfo | null } | undefined;
  let pair: PairInfo | null = null;
  if (config.pair) {
    const { token, created } = loadPairingToken(config.homeDir, { reset: config.resetPairing, fixed: config.token });
    if (config.resetPairing) {
      console.log(config.token
        ? '[Bridge] --reset-pairing ignored: BRIDGE_TOKEN is set and is the pairing token'
        : '[Bridge] Pairing token rotated: every paired device has to scan the new code');
    } else if (created) console.log(`[Bridge] New pairing token in ${path.join(config.homeDir, 'pairing.json')}`);
    pairing = { token, info: () => pair };
  }

  // Discovery: scan, then a read-only Muse turn ranks the candidates.
  const suggestions = new Suggestions({
    enabled: config.discover,
    registered: async () => (await projectStore.loadAll()).map(p => ({ slug: p.slug, directory: p.directory })),
    scan: async (exclude) => scanProjects(await resolveScanRoots(config.scanRoots), { exclude }),
    rank: (prompt) => sessionManager.oneShot(prompt, { key: ONE_SHOT_KEY, timeoutMs: MUSE_RANK_TIMEOUT_MS, effort: 'low' }),
  });
  wireBridgeEvents({ commandRouter, feed, suggestions });
  const toFeed = suggestions.onChange;
  suggestions.onChange = (snap) => {
    toFeed?.(snap);
    if (snap.state === 'ready' || snap.state === 'failed') printSuggestions(snap);
  };

  const app = createApp({ commandRouter, projectStore, sessionManager, config, sseClients, broadcast, feed, runJournal, pairing, suggestions });
  const stopCron = config.cron
    ? startCronJobs({ commandRouter, projectStore, config, broadcast, feed, runJournal })
    : () => {};

  let boundPort = config.port;
  // Start discovery at once, alongside binding: it only touches the disk and, later, Muse.
  if (config.discover) setImmediate(() => { void suggestions.refresh(); });

  // 'main' failures are fatal; 'extra' survives a missing address family; 'lan' survives any
  // address problem (an interface that went away, an address another process holds).
  const listen = (host: string, port: number, kind: 'main' | 'extra' | 'lan') => new Promise<Server | null>((resolve, reject) => {
    const srv = app.listen(port, host, () => {
      const actual = (srv.address() as { port: number } | null)?.port ?? port;
      console.log(`[Bridge] Listening on ${host.includes(':') ? `[${host}]` : host}:${actual}`);
      resolve(srv);
    });
    srv.on('error', (err: NodeJS.ErrnoException) => {
      // A missing address family (e.g. IPv6 off) is survivable for extra hosts, and so is any
      // LAN address that went away; anything else (EADDRINUSE on the main host) is fatal.
      if (kind !== 'main' && (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT' || (kind === 'lan' && err.code === 'EADDRINUSE'))) {
        console.warn(`[Bridge] Not listening on ${host}: ${err.code}`);
        resolve(null);
        return;
      }
      reject(err);
    });
  });

  // The first host fixes the port (it may be 0 = any); the rest share it.
  const first = await listen(config.hosts[0], config.port, 'main');
  const port = (first?.address() as { port: number } | null)?.port ?? config.port;
  boundPort = port;
  const rest = await Promise.all(config.hosts.slice(1).map(h => listen(h, port, 'extra')));
  const lan = config.pair ? pairListenAddresses(config.hosts, lanAddresses(opts.interfaces)) : [];
  const wildcard = config.hosts.some(h => WILDCARD_HOSTS.has(h));
  const lanServers = wildcard ? [] : await Promise.all(lan.map(a => listen(a.address, port, 'lan')));
  const lanLive = wildcard ? lan : lan.filter((_, i) => lanServers[i] !== null);
  const live = [first, ...rest, ...lanServers].filter((s): s is Server => s !== null);

  console.log(`[Bridge] muse: ${config.musePath}`);
  console.log(`[Bridge] Projects dir: ${config.projectsDir}`);
  console.log(`[Bridge] Registered: ${projects.map(p => p.slug).join(', ') || 'none'}`);
  console.log(`[Bridge] Auth: loopback ${config.token ? 'needs BRIDGE_TOKEN' : 'open'}; ${
    pairing ? 'LAN needs the pairing token' : config.token ? 'other addresses need BRIDGE_TOKEN' : 'no LAN access'}`);

  if (pairing) {
    if (lanLive.length) {
      pair = pairInfo(lanLive, port, pairing.token);
      console.warn(
        `[Bridge] PAIRING ON: listening on your LAN (${lanLive.map(a => `${a.address} ${a.iface}`).join(', ')}) over plain HTTP. ` +
        'Anyone on this network who has the pairing token can run agents with every action pre-approved (--yolo) as you. ' +
        'Use a trusted Wi-Fi; start with --no-pair to stay on loopback, --reset-pairing to unpair every device.');
      // Rendering is async and off the startup path: it never delays listening or discovery.
      const info = pair;
      void renderTerminalQr(info.payload, !!process.stdout.isTTY).then((qr) => {
        out(`\n${qr}\n${PAIR_CAPTION}\nAlso at http://localhost:${port}/pair (this machine only). Addresses: ${info.urls.join(', ')}\n`);
      }).catch((err) => console.warn(`[Bridge] Could not draw the pairing QR: ${(err as Error).message}`));
    } else {
      console.warn('[Bridge] Pairing on, but no private LAN address found (Wi-Fi off?): loopback only. Restart once connected.');
    }
  }

  function printSuggestions(snap: SuggestionsSnapshot): void {
    if (snap.state === 'failed') { out(`[Suggestions] Discovery failed: ${snap.error ?? 'unknown error'}`); return; }
    if (!snap.items.length) { out('[Suggestions] No new projects found to suggest.'); return; }
    const home = os.homedir();
    const tilde = (d: string) => (d === home || d.startsWith(home + path.sep) ? `~${d.slice(home.length)}` : d);
    const w = Math.max(...snap.items.map(i => i.slug.length));
    const auth = config.token ? ` -H "Authorization: Bearer $BRIDGE_TOKEN"` : '';
    out([
      `[Suggestions] Recently edited projects (accept in the headset, or: curl -X POST${auth} localhost:${boundPort}/suggestions/<slug>/accept):`,
      ...snap.items.map(i => `  ${i.slug.padEnd(w)}  ${tilde(i.directory)}  ${i.reason}`),
    ].join('\n'));
  }

  return {
    servers: live,
    async close(drainMs = 30_000) {
      stopCron();
      clearInterval(usagePoll);
      sessionManager.stop(ONE_SHOT_KEY);
      // Release the port at once (so a restart can bind), then let running turns finish.
      for (const server of live) {
        server.close();
        server.closeAllConnections?.();
      }
      const drained = await sessionManager.waitForIdle(drainMs);
      await sessionManager.closeAll?.(); // serve hosts are persistent; exec has none
      return drained;
    },
  };
}
