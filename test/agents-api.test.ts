import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter, Readable, PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import request from 'supertest';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFileSync: vi.fn(() => '') }));
import { spawn } from 'node:child_process';
import { createApp, type AppDeps } from '../src/app.js';
import { CommandRouter } from '../src/command-router.js';
import { SessionManager } from '../src/session-manager.js';
import { ProjectStore } from '../src/project-store.js';
import { Feed } from '../src/feed.js';

// ── fixtures ────────────────────────────────────────────────────────────────

let tmpDir: string;
let projectStore: ProjectStore;
let servers: Server[];

type Ev = { seq: number; frameId: number; slug: string; runId: string; type: string; [k: string]: unknown };

const idleSessionManager = () => ({
  onSpawn: () => () => {},
  stop: vi.fn((slug: string) => ({ stopped: false, reason: `Nothing running for /${slug}` })),
  resetSession: () => {},
  isRunning: () => false,
}) as unknown as SessionManager;

function makeApp(extra: Partial<AppDeps> = {}, config: Partial<AppDeps['config']> = {}) {
  return createApp({
    commandRouter: { handle: async () => ({ response: 'ok' }) } as unknown as CommandRouter,
    projectStore,
    sessionManager: idleSessionManager(),
    config: { token: undefined, allowedOrigins: [], maxRequestsPerMinute: 60, senderName: 'user', ...config },
    sseClients: new Set(),
    broadcast: () => {},
    ...extra,
  });
}

async function listen(app: ReturnType<typeof createApp>): Promise<string> {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise(r => server.once('listening', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** Open GET /feed and collect frames until closed. */
async function openFeed(base: string, query = '', headers: Record<string, string> = {}) {
  const ac = new AbortController();
  const res = await fetch(`${base}/feed${query}`, { headers, signal: ac.signal });
  const events: Ev[] = [];
  const comments: string[] = [];
  if (res.ok && res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = frame.match(/^data: (.*)$/m);
            if (!data) { comments.push(frame); continue; }
            const id = Number(frame.match(/^id: (\d+)$/m)?.[1]);
            events.push({ ...JSON.parse(data[1]), frameId: id });
          }
        }
      } catch { /* aborted */ }
    })();
  }
  const waitFor = async (pred: (evs: Ev[]) => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred(events)) {
      if (Date.now() > end) throw new Error(`feed condition not met; got ${JSON.stringify(events.map(e => `${e.seq}:${e.slug}:${e.type}`))}`);
      await new Promise(r => setTimeout(r, 5));
    }
  };
  return { res, events, comments, waitFor, close: () => ac.abort() };
}

const idle = (slug: string, n = 1) => (evs: Ev[]) =>
  evs.filter(e => e.slug === slug && e.type === 'agent_state' && e.busy === false).length >= n;

const ask = (base: string, slug: string) => fetch(`${base}/ask`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ trigger: { type: 'inline', query: null, replyTo: null, originalMessage: `/${slug} go` } }),
});

async function register(slug: string, extra: Record<string, unknown> = {}) {
  const dir = path.join(tmpDir, `ws-${slug}`);
  await fs.mkdir(dir, { recursive: true });
  const p = await projectStore.create({ title: `Title ${slug}`, slug, description: '', directory: dir, autoDecide: false });
  if (Object.keys(extra).length) await projectStore.save({ ...p, ...extra });
  return dir;
}

beforeEach(async () => {
  vi.mocked(spawn).mockReset();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-bridge-agents-'));
  projectStore = new ProjectStore(path.join(tmpDir, 'projects'));
  await projectStore.init();
  servers = [];
});

afterEach(async () => {
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── GET /agents ─────────────────────────────────────────────────────────────

describe('GET /agents', () => {
  it('returns every project in the contract shape, with optional avatar/color/voice and the pending decision', async () => {
    await register('beta');
    await register('alpha', {
      avatar: 'robot-02', color: '#4caf50', voice: 'en-US-Neural2-F',
      decision: { summary: 'Use Postgres?', rating: 6, deadline: '2026-11-08T10:00:00.000Z', pausedRemaining: null, at: '2026-11-07T10:00:00.000Z' },
    });
    const res = await request(makeApp()).get('/agents');
    expect(res.status).toBe(200);
    expect(res.body.agents.map((a: { slug: string }) => a.slug)).toEqual(['alpha', 'beta']);
    expect(res.body.agents[0]).toEqual({
      slug: 'alpha', title: 'Title alpha', busy: false, runId: null, lastRunAt: null,
      decision: { text: 'Use Postgres?', rating: 6, at: '2026-11-07T10:00:00.000Z' },
      lastSpeech: null, avatar: 'robot-02', color: '#4caf50', voice: 'en-US-Neural2-F',
    });
    expect(res.body.agents[1]).toEqual({
      slug: 'beta', title: 'Title beta', busy: false, runId: null, lastRunAt: null,
      decision: null, lastSpeech: null, avatar: null, color: null, voice: null,
    });
  });

  it('falls back to lastConversationAt for decision.at in older project files, and ignores a rating-0 decision', async () => {
    await register('old', {
      lastConversationAt: '2026-11-01T08:00:00.000Z',
      decision: { summary: 'Pick a name', rating: 2, deadline: '', pausedRemaining: 3 },
    });
    await register('zero', { decision: { summary: 'continue', rating: 0, deadline: '', pausedRemaining: null } });
    const { agents } = (await request(makeApp()).get('/agents')).body;
    expect(agents[0]).toMatchObject({ slug: 'old', lastRunAt: '2026-11-01T08:00:00.000Z', decision: { text: 'Pick a name', rating: 2, at: '2026-11-01T08:00:00.000Z' } });
    expect(agents[1]).toMatchObject({ slug: 'zero', decision: null });
  });

  it('reports busy + runId while a run is in flight, then lastRunAt and lastSpeech', async () => {
    await register('alpha');
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const router = {
      handle: async (_p: unknown, onMessage?: (t: string) => void) => {
        onMessage?.('Working on **it** 🚧');
        await gate;
        onMessage?.('{"tldr":"Done with `x`.","decision":"Ship?","rating":10}');
        return { response: 'Done' };
      },
    } as unknown as CommandRouter;
    const app = makeApp({ commandRouter: router });
    const base = await listen(app);
    const pending = ask(base, 'alpha');
    let busy: { busy: boolean; runId: string | null } | undefined;
    for (let i = 0; i < 200 && !busy?.busy; i++) {
      busy = (await request(app).get('/agents')).body.agents[0];
      await new Promise(r => setTimeout(r, 5));
    }
    expect(busy).toMatchObject({ busy: true, runId: expect.any(String), lastSpeech: 'Working on it' });
    release();
    await pending;
    const after = (await request(app).get('/agents')).body.agents[0];
    expect(after).toMatchObject({ busy: false, runId: null, lastSpeech: 'Done with.' });
    expect(new Date(after.lastRunAt).getTime()).toBeGreaterThan(Date.now() - 10_000);
  });
});

// ── GET /feed ───────────────────────────────────────────────────────────────

function scriptedRouter() {
  return {
    handle: async (p: { trigger: { originalMessage: string } }, onMessage?: (t: string, m?: { parentId: string }) => void, onToolUse?: (n: string, d: string, m?: object) => void) => {
      onMessage?.('Looking around.');
      onToolUse?.('Bash', 'ls -la', { parentId: null });
      onToolUse?.('Agent', '{"description":"scout"}', { id: 'sa-1', parentId: null });
      onMessage?.('found 3 files', { parentId: 'sa-1' });
      onToolUse?.('Agent', '', { id: 'sa-1', done: true, status: 'completed' });
      onMessage?.('{"tldr":"All **good** ✅","other_findings":"","assumptions_made":"","decision":"Deploy to prod?","rating":7}');
      return { response: `reply to ${p.trigger.originalMessage}` };
    },
  } as unknown as CommandRouter;
}

describe('GET /feed', () => {
  it('streams a run in order with global seq ids and the contract payloads', async () => {
    await register('alpha');
    const base = await listen(makeApp({ commandRouter: scriptedRouter() }));
    const feed = await openFeed(base, '?client=test');
    expect(feed.res.headers.get('content-type')).toContain('text/event-stream');
    await ask(base, 'alpha');
    await feed.waitFor(idle('alpha'));
    const evs = feed.events;
    expect(evs.map(e => e.type)).toEqual(['run', 'agent_state', 'message', 'tool', 'tool', 'message', 'agent_done', 'message', 'done', 'agent_state']);
    expect(evs.map(e => e.seq)).toEqual(evs.map((_, i) => evs[0].seq + i));
    for (const e of evs) {
      expect(e.frameId).toBe(e.seq);
      expect(e.slug).toBe('alpha');
      expect(e.runId).toBe(evs[0].runId);
    }
    expect(evs[0]).toMatchObject({ type: 'run', source: 'ask' });
    expect(evs[1]).toMatchObject({ type: 'agent_state', busy: true });
    expect(evs[2]).toMatchObject({ type: 'message', text: 'Looking around.', speech: 'Looking around.', parentId: null });
    expect(evs[3]).toMatchObject({ type: 'tool', name: 'Bash', detail: 'ls -la', id: null, parentId: null });
    expect(evs[4]).toMatchObject({ type: 'tool', name: 'Agent', id: 'sa-1' });
    expect(evs[5]).toMatchObject({ type: 'message', text: 'found 3 files', parentId: 'sa-1' });
    expect(evs[6]).toMatchObject({ type: 'agent_done', id: 'sa-1', status: 'completed' });
    expect(evs[7]).toMatchObject({ type: 'message', text: '# TLDR\nAll **good** ✅', speech: 'All good' });
    expect(evs[8]).toEqual({
      frameId: evs[8].seq, seq: evs[8].seq, slug: 'alpha', runId: evs[0].runId, type: 'done',
      response: 'reply to /alpha go', speech: 'All good', decision: 'Deploy to prod?', rating: 7,
    });
    expect(evs[9]).toMatchObject({ type: 'agent_state', busy: false });
    feed.close();
  });

  it('carries no events for bridge commands (/list) and no replay without a cursor', async () => {
    await register('alpha');
    const app = makeApp({ commandRouter: scriptedRouter() });
    const base = await listen(app);
    await ask(base, 'alpha'); // before the subscriber: not replayed without a cursor
    await ask(base, 'list');
    const feed = await openFeed(base);
    await new Promise(r => setTimeout(r, 50));
    expect(feed.events).toEqual([]);
    expect(feed.comments).toContain(': ping');
    feed.close();
  });

  it('resumes with ?after=<seq> and with the Last-Event-ID header', async () => {
    await register('alpha');
    const base = await listen(makeApp({ commandRouter: scriptedRouter() }));
    const live = await openFeed(base);
    await ask(base, 'alpha');
    await live.waitFor(idle('alpha'));
    live.close();
    const all = live.events;
    const cut = all[3].seq;

    const viaQuery = await openFeed(base, `?after=${cut}`);
    await viaQuery.waitFor(evs => evs.length >= all.length - 4);
    const viaHeader = await openFeed(base, '', { 'Last-Event-ID': String(cut) });
    await viaHeader.waitFor(evs => evs.length >= all.length - 4);
    expect(viaQuery.events.map(e => e.seq)).toEqual(all.slice(4).map(e => e.seq));
    expect(viaHeader.events).toEqual(viaQuery.events);

    // ...and then continues live, without duplicates.
    await ask(base, 'alpha');
    await viaHeader.waitFor(idle('alpha', 2));
    const seqs = viaHeader.events.map(e => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

    const fromZero = await openFeed(base, '?after=0');
    await fromZero.waitFor(evs => evs.length >= all.length * 2);
    expect(fromZero.events.length).toBe(all.length * 2);
    // A cursor from a previous bridge process (beyond the newest seq) replays everything.
    const stale = await openFeed(base, '?after=999999');
    await stale.waitFor(evs => evs.length >= all.length * 2);
    for (const f of [viaQuery, viaHeader, fromZero, stale]) f.close();
  });

  it('interleaves concurrent runs of different agents, each run in order', async () => {
    await register('alpha');
    await register('beta');
    const gates = new Map<string, () => void>();
    const router = {
      handle: async (p: { trigger: { originalMessage: string } }, onMessage?: (t: string) => void) => {
        const slug = p.trigger.originalMessage.slice(1).split(' ')[0];
        onMessage?.(`${slug} step 1`);
        await new Promise<void>(r => gates.set(slug, r));
        onMessage?.(`${slug} step 2`);
        return { response: `${slug} done` };
      },
    } as unknown as CommandRouter;
    const base = await listen(makeApp({ commandRouter: router }));
    const feed = await openFeed(base);
    const a = ask(base, 'alpha');
    await feed.waitFor(evs => evs.some(e => e.text === 'alpha step 1'));
    const b = ask(base, 'beta');
    await feed.waitFor(evs => evs.some(e => e.text === 'beta step 1'));
    gates.get('alpha')!();
    await feed.waitFor(idle('alpha'));
    gates.get('beta')!();
    await feed.waitFor(idle('beta'));
    await Promise.all([a, b]);

    const evs = feed.events;
    expect(evs.map(e => e.seq)).toEqual(evs.map((_, i) => evs[0].seq + i));
    expect(evs.filter(e => e.type === 'message').map(e => e.text)).toEqual(['alpha step 1', 'beta step 1', 'alpha step 2', 'beta step 2']);
    const runA = evs.find(e => e.slug === 'alpha')!.runId;
    const runB = evs.find(e => e.slug === 'beta')!.runId;
    expect(runA).not.toBe(runB);
    for (const [slug, runId] of [['alpha', runA], ['beta', runB]]) {
      const own = evs.filter(e => e.slug === slug);
      expect(own.every(e => e.runId === runId)).toBe(true);
      expect(own.map(e => e.type)).toEqual(['run', 'agent_state', 'message', 'message', 'done', 'agent_state']);
    }
    feed.close();
  });

  it('carries /ask/stream runs under the same runId, with speech on message and done', async () => {
    await register('alpha');
    const app = makeApp({ commandRouter: scriptedRouter() });
    const base = await listen(app);
    const feed = await openFeed(base);
    const res = await request(app).post('/ask/stream')
      .send({ trigger: { type: 'inline', query: null, replyTo: null, originalMessage: '/alpha go' } });
    const stream = res.text.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
    await feed.waitFor(idle('alpha'));
    const runId = stream[0].runId;
    expect(feed.events[0]).toMatchObject({ type: 'run', runId, source: 'ask/stream' });
    expect(stream.find(e => e.type === 'message' && e.text === 'Looking around.')).toEqual({ type: 'message', text: 'Looking around.', speech: 'Looking around.' });
    expect(stream.find(e => e.type === 'done')).toMatchObject({ speech: 'All good', decision: 'Deploy to prod?', rating: 7, singleShot: false });
    // Stream-only events stay off the feed.
    expect(feed.events.some(e => ['meta', 'final_prompt', 'cli_params'].includes(e.type))).toBe(false);
    feed.close();
  });

  it('feeds error and aborted runs', async () => {
    await register('alpha');
    await register('beta');
    const router = {
      handle: async (p: { trigger: { originalMessage: string } }) => {
        throw new Error(p.trigger.originalMessage.startsWith('/alpha') ? 'Muse run failed: auth expired' : 'Query aborted: process terminated unexpectedly');
      },
    } as unknown as CommandRouter;
    const base = await listen(makeApp({ commandRouter: router }));
    const feed = await openFeed(base);
    await ask(base, 'alpha');
    await ask(base, 'beta');
    await feed.waitFor(evs => idle('alpha')(evs) && idle('beta')(evs));
    expect(feed.events.find(e => e.slug === 'alpha' && e.type === 'error')).toMatchObject({ error: 'Muse run failed: auth expired' });
    expect(feed.events.some(e => e.slug === 'beta' && e.type === 'aborted')).toBe(true);
    feed.close();
  });

  it('sends a `: ping` keep-alive', async () => {
    const base = await listen(makeApp({ feedPingMs: 15 }));
    const feed = await openFeed(base);
    await new Promise(r => setTimeout(r, 80));
    expect(feed.comments.filter(c => c === ': ping').length).toBeGreaterThanOrEqual(3);
    feed.close();
  });
});

// ── POST /agents/:slug/ask (mocked muse spawn) ──────────────────────────────

// Event shapes recorded from Muse Code 1.4.14 (`muse exec --json`), as in muse-provider.test.ts.
const ev = (payload_type: string, payload: object) => ({ payload_type, payload: { kind: 'x', ...payload } });
const delta = (text: string) => ev('run.output.delta', { text });
const proposed = (task_kind: string) => ev('task.lifecycle.proposed', { event: { kind: 'proposed', task_kind } });
const toolResult = (tool_name: string, text: string) => ev('tool.result', { text, correlation_facts: { tool_name, outcome: 'success' } });
const done = (text: string) => ev('run.terminal.completed', { terminal: 'completed', text, reason: null });

let prompts: string[];
function queueMuse(lines: object[], closeAfterMs = 20) {
  const proc = Object.assign(new EventEmitter(), {
    stdout: Readable.from([lines.map(l => JSON.stringify(l)).join('\n') + '\n']),
    stderr: Readable.from([]), stdin: new PassThrough(), kill: vi.fn(), pid: 4242, exitCode: null, signalCode: null,
  });
  vi.mocked(spawn).mockImplementationOnce(((_cmd: string, args: string[]) => {
    prompts.push(args[args.indexOf('--prompt-file') + 1]);
    setTimeout(() => { Object.assign(proc, { exitCode: 0 }); proc.emit('close', 0, null); }, closeAfterMs);
    return proc as any;
  }) as any);
}

describe('POST /agents/:slug/ask', () => {
  function realApp(extra: Partial<AppDeps> = {}, config: Partial<AppDeps['config']> = {}) {
    const sessionManager = new SessionManager({ musePath: '/opt/bin/muse', envPassthrough: [] });
    const commandRouter = new CommandRouter(sessionManager, projectStore);
    const feed = new Feed();
    return { app: makeApp({ commandRouter, sessionManager, feed, ...extra }, config), feed };
  }
  beforeEach(() => { prompts = []; });

  it('returns 202 {runId} at once; the turn runs on muse and arrives on /feed', async () => {
    const dir = await register('alpha');
    const reply = '{"tldr":"Added a **jump** button. See `Player.cs`.","other_findings":"","assumptions_made":"","decision":"Tune the jump height?","rating":10}';
    queueMuse([delta('Checking the player.'), proposed('tool.bash'), toolResult('bash', JSON.stringify({ command: 'ls' })), done(reply)]);
    const { app } = realApp();
    const base = await listen(app);
    const feed = await openFeed(base);

    const t0 = Date.now();
    const res = await fetch(`${base}/agents/alpha/ask`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'add a jump button', sender: 'pilot' }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ runId: expect.any(String) });
    expect(Date.now() - t0).toBeLessThan(1000);

    await feed.waitFor(idle('alpha'));
    const evs = feed.events;
    expect(evs.every(e => e.runId === body.runId && e.slug === 'alpha')).toBe(true);
    expect(evs.map(e => e.type)).toEqual(['run', 'agent_state', 'message', 'tool', 'message', 'message', 'done', 'agent_state']);
    expect(evs[0]).toMatchObject({ source: 'agents' });
    expect(evs[2]).toMatchObject({ text: 'Checking the player.', speech: 'Checking the player.', parentId: null });
    expect(evs[3]).toMatchObject({ name: 'Bash', detail: 'ls', parentId: null });
    expect(evs[4]).toMatchObject({ speech: 'Added a jump button. See.' });
    expect(evs[5].text).toContain('Decision needed (rating 10)');
    expect(evs[6]).toMatchObject({ speech: 'Added a jump button. See.', decision: 'Tune the jump height?', rating: 10 });

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(expect.arrayContaining(['--workspace', dir]));

    // The decision is now pending on /agents; the next message answers (clears) it.
    const agent = (await request(app).get('/agents')).body.agents[0];
    expect(agent).toMatchObject({ slug: 'alpha', busy: false, decision: { text: 'Tune the jump height?', rating: 10, at: expect.any(String) }, lastSpeech: expect.any(String) });
    // The run is also resumable on /runs/:id/events.
    const resumed = await request(app).get(`/runs/${body.runId}/events`);
    expect(resumed.text).toContain('"type":"done"');
    feed.close();
  });

  it('queues behind a busy agent and still returns the runId', async () => {
    await register('alpha');
    queueMuse([done('{"tldr":"one","decision":"A?","rating":10}')], 150);
    queueMuse([done('{"tldr":"two","decision":"B?","rating":10}')]);
    const { app } = realApp();
    const base = await listen(app);
    const feed = await openFeed(base);
    const post = (text: string) => fetch(`${base}/agents/alpha/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    const r1 = await (await post('first')).json();
    const r2res = await post('second');
    expect(r2res.status).toBe(202);
    const r2 = await r2res.json();
    expect(r2).toEqual({ runId: expect.any(String), queued: true });
    expect(r2.runId).not.toBe(r1.runId);
    await feed.waitFor(evs => evs.filter(e => e.type === 'done').length === 2);
    await feed.waitFor(idle('alpha'));
    const dones = feed.events.filter(e => e.type === 'done');
    expect(dones.map(e => [e.runId, e.speech])).toEqual([[r1.runId, 'one'], [r2.runId, 'two']]);
    // The first run's end leaves the agent busy (the queued one is still open); only the last end is idle.
    const states = feed.events.filter(e => e.type === 'agent_state').map(e => e.busy);
    expect(states).toEqual([true, true, true, false]);
    feed.close();
  });

  it('404s an unknown slug and 400s a missing text', async () => {
    await register('alpha');
    const app = makeApp();
    expect((await request(app).post('/agents/nope/ask').send({ text: 'hi' })).status).toBe(404);
    expect((await request(app).post('/agents/..%2Fprojects%2Falpha/ask').send({ text: 'hi' })).status).toBe(404);
    expect((await request(app).post('/agents/alpha/ask').send({})).status).toBe(400);
    expect((await request(app).post('/agents/alpha/ask').send({ text: '  ' })).status).toBe(400);
    expect((await request(app).post('/agents/alpha/ask').send({ text: 'x', sender: 5 })).status).toBe(400);
  });

  it('counts against MAX_RPM like /ask, but /feed and /agents do not', async () => {
    await register('alpha');
    const app = makeApp({}, { maxRequestsPerMinute: 1 });
    const base = await listen(app);
    const feeds = await Promise.all([openFeed(base), openFeed(base), openFeed(base)]);
    for (let i = 0; i < 3; i++) expect((await request(app).get('/agents')).status).toBe(200);
    expect((await request(app).post('/agents/alpha/ask').send({ text: 'hi' })).status).toBe(202);
    expect((await request(app).post('/agents/alpha/ask').send({ text: 'hi' })).status).toBe(429);
    feeds.forEach(f => f.close());
  });
});

describe('POST /agents/:slug/stop', () => {
  it('is an alias of POST /stop', async () => {
    const sessionManager = idleSessionManager();
    const app = makeApp({ sessionManager });
    const res = await request(app).post('/agents/Alpha/stop');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', stopped: false, reason: 'Nothing running for /alpha' });
    expect(sessionManager.stop).toHaveBeenCalledWith('alpha');
    const viaOld = await request(app).post('/stop').send({ slug: 'alpha' });
    expect(viaOld.body).toEqual(res.body);
  });
});

describe('auth and origin on the new endpoints', () => {
  it('requires BRIDGE_TOKEN when set', async () => {
    await register('alpha');
    const app = makeApp({}, { token: 's3cret' });
    const base = await listen(app);
    const auth = { Authorization: 'Bearer s3cret' };
    expect((await request(app).get('/agents')).status).toBe(401);
    expect((await request(app).get('/agents').set(auth)).status).toBe(200);
    expect((await request(app).post('/agents/alpha/ask').send({ text: 'hi' })).status).toBe(401);
    expect((await request(app).post('/agents/alpha/stop')).status).toBe(401);
    expect((await fetch(`${base}/feed`)).status).toBe(401);
    const ok = await openFeed(base, '', auth);
    expect(ok.res.status).toBe(200);
    ok.close();
    expect((await request(app).post('/agents/alpha/ask').set(auth).send({ text: 'hi' })).status).toBe(202);
  });

  it('refuses browser origins that are not allowed', async () => {
    const app = makeApp();
    const base = await listen(app);
    expect((await request(app).get('/agents').set('Origin', 'https://evil.example')).status).toBe(403);
    expect((await fetch(`${base}/feed`, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await request(app).post('/agents/alpha/ask').set('Origin', 'https://evil.example').send({ text: 'x' })).status).toBe(403);
  });
});
