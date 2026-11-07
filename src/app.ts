import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import type { AskPayload, AskResponse, HealthResponse, NotifyPayload } from './types.js';
import type { CommandRouter } from './command-router.js';
import { GLOBAL_COMMANDS } from './command-router.js';
import type { ProjectStore } from './project-store.js';
import type { Config } from './config.js';
import { getMuseUsage } from './muse-usage.js';
import type { SessionManager } from './session-manager.js';
import { debug } from './debug.js';
import { RunJournal, type JournalEvent } from './run-journal.js';
import { Feed, type FeedEvent } from './feed.js';
import { createRun, type RunReporter, type RunSource } from './run-reporter.js';
import { isLoopbackAddress, pairPageHtml, renderSvgQr, type PairInfo } from './pairing.js';
import type { Suggestions } from './suggestions.js';
import type { ProjectConfig } from './types.js';

/** One SSE frame with its journal sequence as the event id. */
function sseFrame(ev: JournalEvent): string {
  return `id: ${ev.seq}\ndata: ${JSON.stringify(ev.data)}\n\n`;
}

/** An /events connection, tagged with the client kind it identified as (?client=). */
export type SseResponse = express.Response & { clientKind?: string };

export interface AppDeps {
  commandRouter: CommandRouter;
  projectStore: ProjectStore;
  sessionManager: SessionManager;
  config: Pick<Config, 'token' | 'allowedOrigins' | 'maxRequestsPerMinute' | 'senderName'>;
  sseClients: Set<SseResponse>;
  /** Pushes a message to every /events subscriber. */
  broadcast: (text: string, slug?: string, projectDirectory?: string) => void;
  /** Journal backing /runs/:id/events resume. Default: a fresh in-memory one. */
  runJournal?: RunJournal;
  /** SSE keep-alive interval (ms). Default 30s; tests shrink it. */
  streamHeartbeatMs?: number;
  /** The global all-agents feed behind GET /feed. Default: a fresh in-memory one. */
  feed?: Feed;
  /** GET /feed keep-alive (`: ping`) interval (ms). Default 15s. */
  feedPingMs?: number;
  /**
   * LAN pairing. When set, requests from non-loopback addresses are accepted with
   * `Authorization: Bearer <token>`, and loopback clients can fetch the QR from GET /pair.
   * `info()` is null until the LAN listeners are up (or when there is no LAN address).
   */
  pairing?: { token: string; info: () => PairInfo | null };
  /** Project discovery behind /suggestions. Without it, GET /suggestions reports `enabled:false`. */
  suggestions?: Suggestions;
  /** The request's remote address (tests override it). Default: the socket's. */
  remoteAddressOf?: (req: express.Request) => string | undefined;
}

/**
 * Bridge-wide feed events: `agents_changed` after a project is registered (any path), and
 * `suggestions` whenever the suggestion list or its state changes.
 */
export function wireBridgeEvents(deps: { commandRouter: CommandRouter; feed: Feed; suggestions?: Suggestions }): void {
  const { commandRouter, feed, suggestions } = deps;
  commandRouter.onAgentsChanged = () => {
    feed.bridgeEvent('agents_changed');
    void suggestions?.pruneRegistered().catch(() => {});
  };
  if (suggestions) suggestions.onChange = (snap) => { feed.bridgeEvent('suggestions', { ...snap }); };
}

/** True when the Host header names this machine's loopback (not a LAN address or a rebound DNS name). */
function loopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.replace(/:\d+$/, '');
  return name.toLowerCase() === 'localhost' || isLoopbackAddress(name);
}

/** Wire shape of one agent in GET /agents. */
export interface AgentInfo {
  slug: string;
  title: string;
  busy: boolean;
  runId: string | null;
  lastRunAt: string | null;
  decision: { text: string; rating: number; at: string } | null;
  lastSpeech: string | null;
  avatar: string | null;
  color: string | null;
  voice: string | null;
}

const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const optString = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const iso = (v: unknown): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number' && !(v instanceof Date)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const SLUG_RE = /^\/([a-z0-9-]+)/i;

function extractSlug(message: string): string | null {
  const m = message?.match(SLUG_RE);
  return m ? m[1].toLowerCase() : null;
}

function tokenMatches(header: string, token: string): boolean {
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' };

export function createApp(deps: AppDeps): express.Express {
  const {
    commandRouter, projectStore, sseClients, broadcast, sessionManager, config,
    streamHeartbeatMs = 30_000, runJournal = new RunJournal(), feed = new Feed(), feedPingMs = 15_000,
  } = deps;
  const app = express();
  const allowedOrigins = new Set(config.allowedOrigins);
  const isAllowedOrigin = (origin: string) => allowedOrigins.has(origin);

  // Non-browser clients send no Origin header. A web page's cross-origin request (or a DNS
  // rebinding attack) always carries one, so anything not explicitly allowed is refused before
  // it can reach /ask and friends from the user's own browser.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!origin || isAllowedOrigin(origin)) return next();
    res.status(403).json({ error: 'Forbidden origin' });
  });
  app.use(cors({ origin: (origin, cb) => cb(null, !origin || isAllowedOrigin(origin)) }));
  app.use(express.json({ limit: '1mb' }));

  // Auth on every route except /health. Loopback: BRIDGE_TOKEN when set, else open (as
  // always). Any other address (the LAN listeners): the pairing token or BRIDGE_TOKEN, always.
  const remoteOf = deps.remoteAddressOf ?? ((req: express.Request) => req.socket.remoteAddress);
  const isLoopbackReq = (req: express.Request) => isLoopbackAddress(remoteOf(req));
  const lanTokens = [config.token, deps.pairing?.token].filter((t): t is string => !!t);
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    const auth = String(req.headers['authorization'] ?? '');
    if (isLoopbackReq(req)) {
      if (!config.token || tokenMatches(auth, config.token)) return next();
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (lanTokens.length === 0) {
      res.status(403).json({ error: 'LAN access is off: pair the device (pairing on) or set BRIDGE_TOKEN' });
      return;
    }
    // Check every token (no early exit) so timing doesn't say which one nearly matched.
    let ok = false;
    for (const t of lanTokens) ok = tokenMatches(auth, t) || ok;
    if (ok) return next();
    res.status(401).json({ error: 'Unauthorized' });
  });

  const stats = { requestsServed: 0, totalMs: 0, lastError: null as string | null };
  const startTime = Date.now();
  const requestTimestamps: number[] = [];
  const maxRpm = config.maxRequestsPerMinute;

  function checkRpm(): boolean {
    const now = Date.now();
    const cutoff = now - 60_000;
    while (requestTimestamps.length > 0 && requestTimestamps[0] < cutoff) requestTimestamps.shift();
    if (requestTimestamps.length >= maxRpm) return false;
    requestTimestamps.push(now);
    return true;
  }

  /**
   * The registered project a command line drives (`/<slug> …`, or `/nudge <slug>`), or null for
   * bridge commands and unknown slugs. Only project runs go on the feed.
   */
  async function projectSlugOf(message: string): Promise<string | null> {
    const m = message.trim().match(/^\/([a-z0-9-]+)\s*(\S*)/i);
    if (!m) return null;
    const cmd = m[1].toLowerCase();
    const slug = cmd === 'nudge' ? m[2].toLowerCase() : (GLOBAL_COMMANDS as readonly string[]).includes(cmd) ? '' : cmd;
    if (!slug || !PROJECT_SLUG_RE.test(slug)) return null;
    return (await projectStore.load(slug)) ? slug : null;
  }

  /** A reporter for one run. Runs of a registered project also go on the feed; all are journaled for /runs/:id/events. */
  const newRun = (slug: string | null, source: RunSource, write?: (ev: JournalEvent) => void): RunReporter =>
    createRun({ slug, source, feed, journal: runJournal, write });

  /** Validate an /ask body. Returns the payload, or null after sending a 400. */
  function readPayload(req: express.Request, res: express.Response): AskPayload | null {
    const { trigger, recentMessages, repliedToMessage, chatId } = (req.body ?? {}) as Partial<AskPayload>;
    if (!trigger || typeof trigger.originalMessage !== 'string') {
      debug('ask', `rejected malformed payload: trigger=${JSON.stringify(trigger)?.slice(0, 200)}`);
      res.status(400).json({ error: 'No trigger provided' });
      return null;
    }
    return {
      trigger: { ...trigger, sender: trigger.sender || config.senderName },
      recentMessages: recentMessages ?? [],
      repliedToMessage: repliedToMessage ?? null,
      chatId,
    };
  }

  app.get('/health', (_req, res) => {
    const resp: HealthResponse = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Date.now() - startTime,
      stats: {
        requestsServed: stats.requestsServed,
        avgResponseMs: stats.requestsServed > 0 ? Math.round(stats.totalMs / stats.requestsServed) : 0,
        lastError: stats.lastError,
      },
    };
    res.json(resp);
  });

  // Force-stop the in-flight turn for a slug. Deliberately NOT rate-limited: an escape hatch
  // that can be refused is not an escape hatch. Idempotent: stopping an idle slug is a 200
  // with stopped:false.
  app.post('/stop', (req, res) => {
    const { slug } = (req.body ?? {}) as { slug?: string };
    if (!slug || typeof slug !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "slug"' });
      return;
    }
    const result = sessionManager.stop(slug.toLowerCase());
    console.log(`[Bridge] /stop ${slug}: ${result.reason}`);
    res.json({ status: 'ok', ...result });
  });

  // Kill whatever runs for the slug AND discard its session, in one shot, for a stuck session.
  // stop() must run before resetSession(): the in-flight turn holds the slug's queue until its
  // process closes.
  app.post('/emergency-reset', async (req, res) => {
    const { slug } = (req.body ?? {}) as { slug?: string };
    if (!slug || typeof slug !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "slug"' });
      return;
    }
    const normalizedSlug = slug.toLowerCase();
    const stopResult = sessionManager.stop(normalizedSlug);
    sessionManager.resetSession(normalizedSlug);

    let projectReset = false;
    const project = await projectStore.load(normalizedSlug);
    if (project) {
      project.sessionId = null;
      project.status = 'Awaiting first message';
      project.decision = null;
      delete (project as Partial<typeof project>).lastConversationAt;
      await projectStore.save(project);
      projectReset = true;
    }

    console.warn(`[Bridge] /emergency-reset ${normalizedSlug}: ${stopResult.reason}; session wiped${projectReset ? '' : ' (no project record)'}`);
    res.json({ status: 'ok', stopped: stopResult.stopped, stopReason: stopResult.reason, projectReset });
  });

  app.get('/projects', async (_req, res) => {
    const slugs = await projectStore.getSlugs();
    res.json({ slugs, commands: [...GLOBAL_COMMANDS] });
  });

  app.get('/usage', (_req, res) => {
    res.json({ muse: getMuseUsage() });
  });

  // Push a message to every /events subscriber, tagged with a project (e.g. from a script).
  app.post('/notify', async (req, res) => {
    const { slug, message } = (req.body ?? {}) as Partial<NotifyPayload>;
    if (!slug || typeof slug !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "slug"' });
      return;
    }
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "message"' });
      return;
    }
    const proj = await projectStore.load(slug);
    if (!proj) {
      res.status(404).json({ error: `Unknown project slug: ${slug}` });
      return;
    }
    broadcast(message, slug, proj.directory);
    res.json({ status: 'ok' });
  });

  // Broadcast feed: auto-decide output from the cron and /notify messages.
  app.get('/events', (req, res) => {
    res.writeHead(200, SSE_HEADERS);
    res.write('data: {"type":"connected"}\n\n');
    const clientKind = typeof req.query.client === 'string' ? req.query.client : 'unknown';
    (res as SseResponse).clientKind = clientKind;
    sseClients.add(res);
    console.log(`[Bridge] SSE client connected: kind=${clientKind} (total ${sseClients.size})`);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), streamHeartbeatMs);
    res.on('close', () => {
      sseClients.delete(res);
      clearInterval(heartbeat);
      console.log(`[Bridge] SSE client disconnected: kind=${clientKind} (total ${sseClients.size})`);
    });
  });

  app.post('/ask', async (req, res) => {
    if (!checkRpm()) {
      res.status(429).json({ error: 'Rate limited. Try again in a minute.' });
      return;
    }
    const payload = readPayload(req, res);
    if (!payload) return;
    const slug = extractSlug(payload.trigger.originalMessage);
    debug('ask', `slug=${slug ?? 'none'} sender=${payload.trigger.sender} chars=${payload.trigger.originalMessage.length}`);

    const start = Date.now();
    // A project turn goes on the feed like any other run; bridge commands (/list, …) don't.
    const projectSlug = await projectSlugOf(payload.trigger.originalMessage);
    const run = projectSlug ? newRun(projectSlug, 'ask') : null;
    run?.start();
    try {
      const { response, parked } = await commandRouter.handle(payload, run?.onMessage, run?.onToolUse, run?.onFinalPrompt);
      const elapsed = Date.now() - start;
      stats.requestsServed++;
      stats.totalMs += elapsed;
      run?.finish(response, { parked });
      const resp: AskResponse = { response, timestamp: new Date().toISOString() };
      res.json(resp);
    } catch (err) {
      const error = err as Error;
      stats.lastError = error.message;
      run?.fail(error);
      process.stderr.write(`[Bridge] Error slug=${slug ?? 'none'} after ${Date.now() - start}ms: ${error.stack || error.message}\n`);
      res.status(500).json({ error: 'Technical issue. Please try again later.' });
    }
  });

  // Streaming endpoint: every intermediate message and tool call as an SSE event.
  app.post('/ask/stream', async (req, res) => {
    if (!checkRpm()) {
      res.status(429).json({ error: 'Rate limited. Try again in a minute.' });
      return;
    }
    const payload = readPayload(req, res);
    if (!payload) return;
    const { trigger } = payload;
    const triggerSlug = extractSlug(trigger.originalMessage);
    console.log(`[Bridge] /ask/stream <- ${triggerSlug ?? 'global'} (${trigger.originalMessage.length} chars, from ${trigger.sender})`);

    res.writeHead(200, SSE_HEADERS);

    // Keep clients' body timeouts from firing during a long silent stretch (one slow tool call).
    const streamHeartbeat = setInterval(() => res.write(': heartbeat\n\n'), streamHeartbeatMs);
    // `res`, not `req`: once express.json() has consumed the body, `req` emits 'close' at once.
    res.on('close', () => clearInterval(streamHeartbeat));

    // Every event is journaled under a run id (first event) with an SSE `id:` sequence, so a
    // client that loses this connection can resume via GET /runs/:id/events?after=<seq>.
    // Writes to a closed response are skipped; the run itself keeps going regardless.
    // Project runs also go on the global feed (GET /feed) under the same run id.
    let run: RunReporter | undefined;
    let unsubscribeSpawn: (() => void) | undefined;
    try {
      const projectSlug = await projectSlugOf(trigger.originalMessage);
      run = newRun(projectSlug, 'ask/stream', (ev) => {
        if (!res.writableEnded && !res.destroyed) res.write(sseFrame(ev));
      });
      run.start();
      const r = run;
      if (triggerSlug) {
        // The exact `muse` flags of every spawn for this project while the stream is open.
        unsubscribeSpawn = sessionManager.onSpawn(triggerSlug, (line) => r.emit({ type: 'cli_params', text: line }));
        const proj = await projectStore.load(triggerSlug);
        if (proj?.directory) r.emit({ type: 'meta', projectDirectory: proj.directory });
      }

      const { response, projectSlug: handledSlug, parked } = await commandRouter.handle(payload, r.onMessage, r.onToolUse, r.onFinalPrompt);

      let projectDirectory: string | null = null;
      if (handledSlug) {
        const proj = await projectStore.load(handledSlug);
        if (proj?.directory) projectDirectory = proj.directory;
      }
      stats.requestsServed++;
      r.finish(response, { projectDirectory, parked });
      res.end();
    } catch (err) {
      const msg = (err as Error).message;
      stats.lastError = msg;
      if (msg.includes('aborted')) console.log(`[Bridge] Stream aborted: ${msg}`);
      else console.error(`[Bridge] Stream error: ${msg}`);
      if (run) run.fail(err);
      else if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'error', error: msg })}\n\n`);
      res.end();
    } finally {
      unsubscribeSpawn?.();
      clearInterval(streamHeartbeat);
    }
  });

  /** One project as GET /agents reports it. */
  const agentInfo = (p: ProjectConfig): AgentInfo => {
    const lastRun = feed.lastRunAt(p.slug);
    const d = p.decision;
    return {
      slug: p.slug,
      title: optString(p.title) ?? p.slug,
      busy: feed.isBusy(p.slug) || sessionManager.isRunning(p.slug),
      runId: feed.currentRunId(p.slug),
      lastRunAt: lastRun != null ? new Date(lastRun).toISOString() : iso(p.lastConversationAt),
      // Only a stored decision is pending: rating 0 auto-continues and is never stored, and
      // the next message to the project clears it.
      decision: d && typeof d.summary === 'string' && typeof d.rating === 'number' && d.rating >= 1
        ? { text: d.summary, rating: d.rating, at: iso(d.at) ?? iso(p.lastConversationAt) ?? iso(p.createdAt) ?? new Date(0).toISOString() }
        : null,
      lastSpeech: feed.lastSpeech(p.slug),
      avatar: optString(p.avatar),
      color: optString(p.color),
      voice: optString(p.voice),
    };
  };

  // Every project's state in one call, for the VR agent list.
  app.get('/agents', async (_req, res) => {
    const projects = (await projectStore.loadAll())
      .filter(p => p && typeof p.slug === 'string')
      .sort((a, b) => a.slug.localeCompare(b.slug));
    res.json({ agents: projects.map(agentInfo) });
  });

  // ── Pairing (loopback only: the page shows the token) ──────────────────────
  // The Host check also defeats DNS rebinding: a web page that rebinds its own name to
  // 127.0.0.1 sends that name, not localhost, in Host.
  const pairGuard = (req: express.Request, res: express.Response): PairInfo | null => {
    if (!isLoopbackReq(req) || !loopbackHostHeader(req.headers.host)) {
      res.status(403).json({ error: 'The pairing code is only shown on this machine (http://localhost)' });
      return null;
    }
    const info = deps.pairing?.info() ?? null;
    if (!info) {
      res.status(404).json({ error: deps.pairing ? 'No LAN address to pair over (connect to Wi-Fi and restart)' : 'Pairing is off (--no-pair)' });
      return null;
    }
    return info;
  };

  app.get('/pair.json', (req, res) => {
    const info = pairGuard(req, res);
    if (info) res.set('Cache-Control', 'no-store').json(info);
  });

  app.get('/pair', async (req, res) => {
    const info = pairGuard(req, res);
    if (!info) return;
    const svg = await renderSvgQr(info.payload);
    res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8' }).send(pairPageHtml(svg, info));
  });

  // ── Suggestions (project discovery) ───────────────────────────────────────
  const suggestions = deps.suggestions;
  const noDiscovery = { state: 'idle', updatedAt: null, items: [], enabled: false };

  app.get('/suggestions', (_req, res) => {
    res.json(suggestions ? suggestions.snapshot() : noDiscovery);
  });

  app.post('/suggestions/refresh', (_req, res) => {
    if (!suggestions?.enabled) {
      res.status(409).json({ error: 'Discovery is off (--no-discover)' });
      return;
    }
    void suggestions.refresh();
    res.status(202).json(suggestions.snapshot());
  });

  app.post('/suggestions/:slug/accept', async (req, res) => {
    const slug = String(req.params.slug ?? '').toLowerCase();
    const item = suggestions?.find(slug);
    if (!suggestions || !item) {
      res.status(404).json({ error: `Unknown suggestion: ${slug}` });
      return;
    }
    const r = await commandRouter.registerProject(item.slug, item.directory, item.title);
    if (!r.ok) {
      res.status(r.code === 'exists' ? 409 : 400).json({ error: r.error });
      return;
    }
    suggestions.remove(item.slug);
    console.log(`[Bridge] suggestion accepted: /${item.slug} -> ${item.directory}`);
    res.json({ agent: agentInfo(r.project) });
  });

  app.post('/suggestions/:slug/dismiss', (req, res) => {
    const slug = String(req.params.slug ?? '').toLowerCase();
    if (!suggestions?.remove(slug, { dismiss: true })) {
      res.status(404).json({ error: `Unknown suggestion: ${slug}` });
      return;
    }
    res.json({ status: 'ok' });
  });

  // Send a turn without holding a connection: 202 at once, the run's events arrive on /feed.
  app.post('/agents/:slug/ask', async (req, res) => {
    const slug = String(req.params.slug ?? '').toLowerCase();
    if (!PROJECT_SLUG_RE.test(slug) || !(await projectStore.load(slug))) {
      res.status(404).json({ error: `Unknown agent: ${slug}` });
      return;
    }
    const { text, sender } = (req.body ?? {}) as { text?: unknown; sender?: unknown };
    if (typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'Missing or invalid "text"' });
      return;
    }
    if (sender !== undefined && sender !== null && typeof sender !== 'string') {
      res.status(400).json({ error: 'Invalid "sender"' });
      return;
    }
    if (!checkRpm()) {
      res.status(429).json({ error: 'Rate limited. Try again in a minute.' });
      return;
    }
    const payload: AskPayload = {
      trigger: { type: 'inline', query: null, sender: sender || config.senderName, replyTo: null, originalMessage: `/${slug} ${text.trim()}` },
      recentMessages: [],
      repliedToMessage: null,
    };
    // Busy: the turn queues behind the running one (or parks, for "For later:"), as on /ask.
    const queued = feed.isBusy(slug) || sessionManager.isRunning(slug);
    const run = newRun(slug, 'agents');
    run.start();
    console.log(`[Bridge] /agents/${slug}/ask <- ${text.length} chars from ${payload.trigger.sender}${queued ? ' (queued)' : ''} run=${run.runId}`);
    res.status(202).json(queued ? { runId: run.runId, queued: true } : { runId: run.runId });

    const start = Date.now();
    try {
      const { response, parked } = await commandRouter.handle(payload, run.onMessage, run.onToolUse, run.onFinalPrompt);
      stats.requestsServed++;
      stats.totalMs += Date.now() - start;
      run.finish(response, { parked });
    } catch (err) {
      stats.lastError = (err as Error).message;
      console.error(`[Bridge] /agents/${slug}/ask run ${run.runId} failed: ${(err as Error).message}`);
      run.fail(err);
    }
  });

  // Same as POST /stop, with the slug in the path.
  app.post('/agents/:slug/stop', (req, res) => {
    const slug = String(req.params.slug ?? '').toLowerCase();
    const result = sessionManager.stop(slug);
    console.log(`[Bridge] /agents/${slug}/stop: ${result.reason}`);
    res.json({ status: 'ok', ...result });
  });

  // One SSE stream for every agent's runs. Resume with ?after=<seq> or Last-Event-ID.
  app.get('/feed', (req, res) => {
    const rawCursor = typeof req.query.after === 'string' ? req.query.after : req.headers['last-event-id'];
    const cursor = Number(Array.isArray(rawCursor) ? rawCursor[0] : rawCursor);
    const hasCursor = rawCursor !== undefined && rawCursor !== '' && Number.isFinite(cursor);
    const clientKind = typeof req.query.client === 'string' ? req.query.client : 'unknown';
    res.writeHead(200, { ...SSE_HEADERS, 'X-Accel-Buffering': 'no' });
    res.socket?.setNoDelay(true);
    res.write(': ping\n\n');
    const frame = (ev: FeedEvent) => `id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`;
    let last = 0;
    const send = (ev: FeedEvent) => {
      if (ev.seq <= last || res.writableEnded || res.destroyed) return;
      last = ev.seq;
      res.write(frame(ev));
    };
    // Replay and subscribe in the same tick: nothing can be appended in between.
    if (hasCursor) for (const ev of feed.since(Math.max(0, cursor))) send(ev);
    last = Math.max(last, feed.lastSeq);
    const unsubscribe = feed.subscribe(send);
    const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, feedPingMs);
    console.log(`[Bridge] /feed connected: kind=${clientKind}${hasCursor ? ` after=${cursor}` : ''} (total ${feed.subscriberCount})`);
    res.on('close', () => {
      clearInterval(ping);
      unsubscribe();
      console.log(`[Bridge] /feed disconnected: kind=${clientKind} (total ${feed.subscriberCount})`);
    });
  });

  // Resume a dropped /ask/stream run: replay events after `after`, then stream the rest live.
  app.get('/runs/:id/events', (req, res) => {
    const id = req.params.id;
    if (!runJournal.has(id)) {
      res.status(404).json({ error: 'Unknown or expired run' });
      return;
    }
    const after = Math.max(0, Number(req.query.after) || 0);
    console.log(`[Bridge] /runs/${id}/events resume after=${after}`);
    res.writeHead(200, SSE_HEADERS);
    let last = after;
    const send = (ev: JournalEvent) => {
      if (ev.seq <= last || res.writableEnded || res.destroyed) return;
      last = ev.seq;
      res.write(sseFrame(ev));
    };
    // Subscribe before replaying so nothing slips between the two; `send` dedups by seq.
    const pending: JournalEvent[] = [];
    let replaying = true;
    const unsubscribe = runJournal.subscribe(id, (ev) => {
      if (replaying) pending.push(ev);
      else { send(ev); if (runJournal.isDone(id)) finish(); }
    });
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), streamHeartbeatMs);
    const finish = () => { clearInterval(heartbeat); unsubscribe(); if (!res.writableEnded) res.end(); };
    res.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
    for (const ev of runJournal.since(id, after)) send(ev);
    for (const ev of pending) send(ev);
    replaying = false;
    if (runJournal.isDone(id)) finish();
  });

  return app;
}
