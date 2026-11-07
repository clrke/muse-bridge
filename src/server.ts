import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { isLoopbackHost, type Config } from './config.js';
import { createApp, type SseResponse } from './app.js';
import { SessionManager } from './session-manager.js';
import { ProjectStore } from './project-store.js';
import { CommandRouter } from './command-router.js';
import { startCronJobs } from './cron.js';
import { persistMuseUsage, pollMuseAllowance } from './muse-usage.js';

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

export async function startServer(config: Config): Promise<RunningBridge> {
  assertSafeExposure(config);
  fs.mkdirSync(config.homeDir, { recursive: true });

  const projectStore = new ProjectStore(config.projectsDir);
  const sessionManager = new SessionManager(config);
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

  const app = createApp({ commandRouter, projectStore, sessionManager, config, sseClients, broadcast });
  const stopCron = config.cron
    ? startCronJobs({ commandRouter, projectStore, config, broadcast })
    : () => {};

  const servers = await Promise.all(config.hosts.map((host, i) => new Promise<Server | null>((resolve, reject) => {
    const srv = app.listen(config.port, host, () => {
      console.log(`[Bridge] Listening on ${host.includes(':') ? `[${host}]` : host}:${config.port}`);
      resolve(srv);
    });
    srv.on('error', (err: NodeJS.ErrnoException) => {
      // A missing address family (e.g. IPv6 off) is survivable for extra hosts; anything
      // else (EADDRINUSE) is fatal.
      if (i > 0 && (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT')) {
        console.warn(`[Bridge] Not listening on ${host}: ${err.code}`);
        resolve(null);
        return;
      }
      reject(err);
    });
  })));
  const live = servers.filter((s): s is Server => s !== null);

  console.log(`[Bridge] muse: ${config.musePath}`);
  console.log(`[Bridge] Projects dir: ${config.projectsDir}`);
  console.log(`[Bridge] Registered: ${projects.map(p => p.slug).join(', ') || 'none'}`);
  console.log(`[Bridge] Auth: ${config.token ? 'bearer token required' : 'none (loopback only)'}`);

  return {
    servers: live,
    async close(drainMs = 30_000) {
      stopCron();
      clearInterval(usagePoll);
      // Release the port at once (so a restart can bind), then let running turns finish.
      for (const server of live) {
        server.close();
        server.closeAllConnections?.();
      }
      return sessionManager.waitForIdle(drainMs);
    },
  };
}
