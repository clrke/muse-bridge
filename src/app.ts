import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import type { AskPayload, AskResponse, HealthResponse, NotifyPayload } from './types.js';
import type { CommandRouter } from './command-router.js';
import { GLOBAL_COMMANDS, stripJsonParts, formatForChat } from './command-router.js';
import type { ProjectStore } from './project-store.js';
import type { Config } from './config.js';
import { getMuseUsage } from './muse-usage.js';
import type { MessageMeta, SessionManager, ToolUseMeta } from './session-manager.js';
import { debug } from './debug.js';
import { RunJournal, type JournalEvent } from './run-journal.js';

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
}

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
  const { commandRouter, projectStore, sseClients, broadcast, sessionManager, config, streamHeartbeatMs = 30_000, runJournal = new RunJournal() } = deps;
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

  // Optional bearer token on every route except /health.
  if (config.token) {
    const token = config.token;
    app.use((req, res, next) => {
      if (req.path === '/health') return next();
      if (tokenMatches(String(req.headers['authorization'] ?? ''), token)) return next();
      res.status(401).json({ error: 'Unauthorized' });
    });
  }

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
    try {
      const { response } = await commandRouter.handle(payload);
      const elapsed = Date.now() - start;
      stats.requestsServed++;
      stats.totalMs += elapsed;
      const resp: AskResponse = { response, timestamp: new Date().toISOString() };
      res.json(resp);
    } catch (err) {
      const error = err as Error;
      stats.lastError = error.message;
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

    // Every event is journaled under a run id (first event) with an SSE `id:` sequence, so a
    // client that loses this connection can resume via GET /runs/:id/events?after=<seq>.
    // Writes to a closed response are skipped; the run itself keeps going regardless.
    const runId = runJournal.create(triggerSlug);
    const emit = (data: Record<string, unknown>) => {
      const ev = runJournal.append(runId, data);
      if (ev && !res.writableEnded && !res.destroyed) res.write(sseFrame(ev));
    };
    emit({ type: 'run', runId });
    // `res`, not `req`: once express.json() has consumed the body, `req` emits 'close' at once.
    res.on('close', () => clearInterval(streamHeartbeat));

    let unsubscribeSpawn: (() => void) | undefined;
    try {
      if (triggerSlug) {
        // The exact `muse` flags of every spawn for this project while the stream is open.
        unsubscribeSpawn = sessionManager.onSpawn(triggerSlug, (line) => emit({ type: 'cli_params', text: line }));
        const proj = await projectStore.load(triggerSlug);
        if (proj?.directory) emit({ type: 'meta', projectDirectory: proj.directory });
      }

      const sentParts = new Set<string>();
      let mainPartsSent = 0; // main-session parts only
      const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
      const { response, projectSlug, parked } = await commandRouter.handle(
        payload,
        (text, meta?: MessageMeta) => {
          const parentId = meta?.parentId ?? null;
          for (const part of stripJsonParts(text)) {
            const formatted = formatForChat(part.trim());
            // Dedup per speaker: a subagent repeating the main session's text still posts.
            const key = normalize(formatted) && `${parentId ?? ''}|${normalize(formatted)}`;
            if (key && !sentParts.has(key)) {
              sentParts.add(key);
              if (!parentId) mainPartsSent++;
              emit(parentId ? { type: 'message', text: formatted, parentId } : { type: 'message', text: formatted });
            }
          }
        },
        (tool, detail, meta?: ToolUseMeta) => emit(
          meta?.done
            ? { type: 'agent_done', id: meta.id, status: meta.status ?? 'completed' }
            : { type: 'tool', name: tool, detail, id: meta?.id, parentId: meta?.parentId ?? null },
        ),
        // The assembled prompt, so a client can show what the agent actually receives.
        (text) => emit({ type: 'final_prompt', text }),
      );

      // `singleShot`: nothing was streamed as `message` (e.g. a command reply), so the
      // client should show `response`.
      const singleShot = mainPartsSent === 0;
      let projectDirectory: string | null = null;
      if (projectSlug) {
        const proj = await projectStore.load(projectSlug);
        if (proj?.directory) projectDirectory = proj.directory;
      }
      stats.requestsServed++;
      emit({ type: 'done', response: formatForChat(response), singleShot, projectDirectory, parked: parked === true });
      res.end();
    } catch (err) {
      const msg = (err as Error).message;
      stats.lastError = msg;
      if (msg.includes('aborted')) {
        console.log(`[Bridge] Stream aborted: ${msg}`);
        emit({ type: 'aborted' });
      } else {
        console.error(`[Bridge] Stream error: ${msg}`);
        emit({ type: 'error', error: msg });
      }
      res.end();
    } finally {
      unsubscribeSpawn?.();
      clearInterval(streamHeartbeat);
    }
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
