import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import express from 'express';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFileSync: vi.fn(() => '') }));
import { createApp, wireBridgeEvents, type AppDeps } from '../src/app.js';
import { CommandRouter } from '../src/command-router.js';
import type { SessionManager } from '../src/session-manager.js';
import { ProjectStore } from '../src/project-store.js';
import { Feed } from '../src/feed.js';
import { Suggestions } from '../src/suggestions.js';
import type { Candidate } from '../src/discovery.js';

let tmpDir: string;
let projectStore: ProjectStore;

const idleSessionManager = () => ({
  onSpawn: () => () => {},
  stop: vi.fn(() => ({ stopped: false, reason: 'idle' })),
  resetSession: () => {},
  isRunning: () => false,
}) as unknown as SessionManager;

/** The remote address comes from an X-Test-Remote header, so one app can play loopback and LAN clients. */
const remoteAddressOf = (req: express.Request) => String(req.headers['x-test-remote'] ?? '127.0.0.1');
const LAN = { 'X-Test-Remote': '192.168.1.50' };
const PAIR_TOKEN = 'MxxWSzS20Bkhiqj_k0xqRw';
const pairInfo = { payload: `musebridge://pair?u=http%3A%2F%2F192.168.1.20%3A3141&t=${PAIR_TOKEN}&n=my-mac`, urls: ['http://192.168.1.20:3141'], hostname: 'my-mac' };

function makeApp(extra: Partial<AppDeps> = {}, config: Partial<AppDeps['config']> = {}) {
  const sessionManager = idleSessionManager();
  const commandRouter = new CommandRouter(sessionManager, projectStore);
  const feed = new Feed();
  const deps: AppDeps = {
    commandRouter, projectStore, sessionManager, feed, remoteAddressOf,
    config: { token: undefined, allowedOrigins: [], maxRequestsPerMinute: 60, senderName: 'user', ...config },
    sseClients: new Set(),
    broadcast: () => {},
    ...extra,
  };
  wireBridgeEvents({ commandRouter: deps.commandRouter, feed: deps.feed!, suggestions: deps.suggestions });
  return { app: createApp(deps), feed: deps.feed!, commandRouter: deps.commandRouter };
}

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'muse-bridge-sugg-')));
  projectStore = new ProjectStore(path.join(tmpDir, 'projects'));
  await projectStore.init();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── auth ────────────────────────────────────────────────────────────────────

describe('auth: loopback vs LAN', () => {
  const pairing = { token: PAIR_TOKEN, info: () => pairInfo };

  it('leaves loopback open without BRIDGE_TOKEN, and needs the pairing token from the LAN', async () => {
    const { app } = makeApp({ pairing });
    expect((await request(app).get('/agents')).status).toBe(200);
    expect((await request(app).get('/agents').set({ 'X-Test-Remote': '::ffff:127.0.0.1' })).status).toBe(200);
    expect((await request(app).get('/agents').set(LAN)).status).toBe(401);
    expect((await request(app).get('/agents').set(LAN).set('Authorization', 'Bearer wrong')).status).toBe(401);
    expect((await request(app).get('/agents').set(LAN).set('Authorization', PAIR_TOKEN)).status).toBe(401);
    expect((await request(app).get('/agents').set(LAN).set('Authorization', `Bearer ${PAIR_TOKEN}`)).status).toBe(200);
    expect((await request(app).get('/health').set(LAN)).status).toBe(200);
  });

  it('with BRIDGE_TOKEN: loopback needs it too, and the LAN accepts it', async () => {
    const { app } = makeApp({ pairing: { token: 'bridge-tok', info: () => pairInfo } }, { token: 'bridge-tok' });
    expect((await request(app).get('/agents')).status).toBe(401);
    expect((await request(app).get('/agents').set('Authorization', 'Bearer bridge-tok')).status).toBe(200);
    expect((await request(app).get('/agents').set(LAN).set('Authorization', 'Bearer bridge-tok')).status).toBe(200);
  });

  it('refuses LAN requests outright when pairing is off and there is no token', async () => {
    const { app } = makeApp();
    expect((await request(app).get('/agents').set(LAN)).status).toBe(403);
    expect((await request(app).get('/agents')).status).toBe(200);
    const withToken = makeApp({}, { token: 't' }).app;
    expect((await request(withToken).get('/agents').set(LAN).set('Authorization', 'Bearer t')).status).toBe(200);
  });

  it('still refuses foreign browser origins, even with the token', async () => {
    const { app } = makeApp({ pairing });
    const res = await request(app).get('/agents').set(LAN).set('Authorization', `Bearer ${PAIR_TOKEN}`).set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });
});

describe('GET /pair and /pair.json', () => {
  const pairing = { token: PAIR_TOKEN, info: () => pairInfo };

  it('serve the payload and an SVG page to loopback clients on localhost', async () => {
    const { app } = makeApp({ pairing });
    const j = await request(app).get('/pair.json').set('Host', 'localhost:3141');
    expect(j.status).toBe(200);
    expect(j.body).toEqual(pairInfo);
    const h = await request(app).get('/pair').set('Host', '127.0.0.1:3141');
    expect(h.status).toBe(200);
    expect(h.headers['content-type']).toMatch(/text\/html/);
    expect(h.text).toContain('<svg');
    expect(h.text).toContain('Scan with Agent Huddle');
    expect((await request(app).get('/pair.json').set('Host', '[::1]:3141')).status).toBe(200);
  });

  it('are 403 from the LAN (even with the token) and for a rebound Host name', async () => {
    const { app } = makeApp({ pairing });
    expect((await request(app).get('/pair.json').set(LAN).set('Authorization', `Bearer ${PAIR_TOKEN}`)).status).toBe(403);
    expect((await request(app).get('/pair').set(LAN).set('Authorization', `Bearer ${PAIR_TOKEN}`)).status).toBe(403);
    expect((await request(app).get('/pair.json').set('Host', 'attacker.example:3141')).status).toBe(403);
  });

  it('are 404 with pairing off or no LAN address', async () => {
    expect((await request(makeApp().app).get('/pair.json').set('Host', 'localhost')).status).toBe(404);
    expect((await request(makeApp({ pairing: { token: PAIR_TOKEN, info: () => null } }).app).get('/pair').set('Host', 'localhost')).status).toBe(404);
  });
});

// ── suggestions ─────────────────────────────────────────────────────────────

describe('/suggestions', () => {
  let dirs: Record<string, string>;
  beforeEach(async () => {
    dirs = {};
    for (const name of ['todo-api', 'my-app']) {
      dirs[name] = path.join(tmpDir, 'code', name);
      await fs.mkdir(dirs[name], { recursive: true });
    }
  });

  const candidates = (): Candidate[] => [
    { name: 'todo-api', directory: dirs['todo-api'], lastModified: Date.now() - 60_000, recentFiles: ['src/app.ts'] },
    { name: 'my-app', directory: dirs['my-app'], lastModified: Date.now() - 3_600_000, recentFiles: [] },
  ];

  function withSuggestions(rank?: (p: string) => Promise<string>) {
    const suggestions = new Suggestions({
      enabled: true, rank, log: () => {},
      scan: async (exclude) => candidates().filter(c => !exclude.includes(c.directory)),
      registered: async () => (await projectStore.loadAll()).map(p => ({ slug: p.slug, directory: p.directory })),
      readme: async () => null,
    });
    return { suggestions, ...makeApp({ suggestions }) };
  }

  it('reports discovery off without a Suggestions instance', async () => {
    const { app } = makeApp();
    expect((await request(app).get('/suggestions')).body).toEqual({ state: 'idle', updatedAt: null, items: [], enabled: false });
    expect((await request(app).post('/suggestions/refresh')).status).toBe(409);
  });

  it('GET returns the current state; every change is a `suggestions` feed event', async () => {
    const { app, feed, suggestions } = withSuggestions(async () => JSON.stringify([
      { slug: 'todo', title: 'Todo API', directory: dirs['todo-api'], reason: 'Adding pagination' },
    ]));
    await suggestions.refresh();
    const res = await request(app).get('/suggestions');
    expect(res.body).toMatchObject({
      state: 'ready', updatedAt: expect.any(String), enabled: true,
      items: [{ slug: 'todo', title: 'Todo API', directory: dirs['todo-api'], reason: 'Adding pagination', lastModified: expect.any(String), recentFiles: ['src/app.ts'] }],
    });
    const evs = feed.since(0);
    expect(evs.map(e => [e.type, e.state])).toEqual([['suggestions', 'scanning'], ['suggestions', 'ranking'], ['suggestions', 'ready']]);
    expect(evs[2]).toMatchObject({ slug: null, runId: null, items: res.body.items, updatedAt: res.body.updatedAt });
  });

  it('accept registers the project like /register, returns {agent}, and emits suggestions + agents_changed', async () => {
    const { app, feed, suggestions } = withSuggestions(async () => 'not json');
    await suggestions.refresh();
    const before = feed.lastSeq;
    const res = await request(app).post('/suggestions/todo-api/accept');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ agent: {
      slug: 'todo-api', title: 'todo-api', busy: false, runId: null, lastRunAt: null, decision: null,
      lastSpeech: null, avatar: null, color: null, voice: null,
    } });
    const project = await projectStore.load('todo-api');
    expect(project).toMatchObject({ slug: 'todo-api', directory: dirs['todo-api'], autoDecide: false, sessionId: null });
    expect(await fs.readFile(path.join(dirs['todo-api'], '.gitignore'), 'utf-8')).toContain('.muse-bridge/');
    expect((await request(app).get('/agents')).body.agents.map((a: { slug: string }) => a.slug)).toEqual(['todo-api']);
    expect((await request(app).get('/suggestions')).body.items.map((i: { slug: string }) => i.slug)).toEqual(['my-app']);
    const types = feed.since(before).map(e => e.type);
    expect(types).toContain('agents_changed');
    expect(types).toContain('suggestions');
    expect(feed.since(before).find(e => e.type === 'agents_changed')).toEqual({ seq: expect.any(Number), slug: null, runId: null, type: 'agents_changed' });
    expect((await request(app).post('/suggestions/todo-api/accept')).status).toBe(404);
  });

  it('accept is 409 when the slug got taken meanwhile, 400 when the directory is gone', async () => {
    const { app, suggestions } = withSuggestions();
    await suggestions.refresh();
    await projectStore.create({ title: 'x', slug: 'todo-api', description: '', directory: tmpDir, autoDecide: false });
    expect((await request(app).post('/suggestions/todo-api/accept')).status).toBe(409);
    await fs.rm(dirs['my-app'], { recursive: true });
    expect((await request(app).post('/suggestions/my-app/accept')).status).toBe(400);
  });

  it('dismiss removes a suggestion (404 when unknown); refresh re-runs discovery (202)', async () => {
    const { app, suggestions, feed } = withSuggestions();
    await suggestions.refresh();
    expect((await request(app).post('/suggestions/my-app/dismiss')).body).toEqual({ status: 'ok' });
    expect((await request(app).post('/suggestions/my-app/dismiss')).status).toBe(404);
    expect(feed.since(0).at(-1)).toMatchObject({ type: 'suggestions', items: [{ slug: 'todo-api' }] });
    const r = await request(app).post('/suggestions/refresh');
    expect(r.status).toBe(202);
    expect(r.body.state).toBe('scanning');
    await suggestions.refresh();
    expect((await request(app).get('/suggestions')).body.items.map((i: { slug: string }) => i.slug)).toEqual(['todo-api']);
  });

  it('a /register through chat also emits agents_changed and drops the matching suggestion', async () => {
    const { app, feed, suggestions } = withSuggestions();
    await suggestions.refresh();
    const res = await request(app).post('/ask').send({ trigger: { type: 'inline', query: null, replyTo: null, originalMessage: `/register todo ${dirs['todo-api']} Todo` } });
    expect(res.body.response).toMatch(/Project registered/);
    expect(feed.since(0).some(e => e.type === 'agents_changed')).toBe(true);
    await vi.waitFor(() => expect(suggestions.snapshot().items.map(i => i.slug)).toEqual(['my-app']));
  });

  it('feed subscribers and ?after= resumers see the bridge events', async () => {
    const { app, suggestions } = withSuggestions();
    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      await suggestions.refresh();
      const ac = new AbortController();
      const res = await fetch(`${base}/feed?after=0`, { signal: ac.signal });
      const reader = res.body!.getReader();
      let text = '';
      while (!text.includes('"state":"ready"')) text += new TextDecoder().decode((await reader.read()).value);
      ac.abort();
      expect(text).toMatch(/id: 1\ndata: \{"seq":1,"slug":null,"runId":null,"type":"suggestions","state":"scanning"/);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });
});
