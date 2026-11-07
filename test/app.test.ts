import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp, type AppDeps } from '../src/app.js';
import type { SessionManager } from '../src/session-manager.js';
import { ProjectStore } from '../src/project-store.js';
import type { CommandRouter } from '../src/command-router.js';
import type express from 'express';

let tmpDir: string;
let projectStore: ProjectStore;
let sseClients: Set<express.Response>;

function mockRouter(response = 'Test response'): CommandRouter {
  return {
    handle: async () => ({ response }),
  } as unknown as CommandRouter;
}

const noopSessionManager = { onSpawn: () => () => {}, stop: () => ({ stopped: false, reason: 'idle' }), resetSession: () => {} } as unknown as SessionManager;

function makeApp(router?: CommandRouter, config: Partial<AppDeps['config']> = {}, extra: Partial<AppDeps> = {}) {
  return createApp({
    commandRouter: router ?? mockRouter(),
    projectStore,
    sessionManager: noopSessionManager,
    config: { token: undefined, allowedOrigins: [], maxRequestsPerMinute: 60, senderName: 'user', ...config },
    sseClients,
    broadcast: () => {},
    ...extra,
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-bridge-app-'));
  projectStore = new ProjectStore(path.join(tmpDir, 'projects'));
  await projectStore.init();
  sseClients = new Set();
});

describe('GET /health', () => {
  it('returns health status', async () => {
    const app = makeApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.stats).toBeDefined();
    expect(res.body.stats.requestsServed).toBe(0);
  });
});

describe('GET /projects', () => {
  it('returns slugs and commands', async () => {
    const app = makeApp();
    const res = await request(app).get('/projects');
    expect(res.status).toBe(200);
    expect(res.body.slugs).toEqual([]);
    expect(res.body.commands).toContain('list');
    expect(res.body.commands).toContain('register');
    expect(res.body.commands).toContain('reset');
    expect(res.body.commands).not.toContain('compact');
    expect(res.body.commands).toContain('nudge');
    expect(res.body.commands).toContain('help');
  });

  it('includes registered project slugs', async () => {
    await projectStore.create({
      title: 'Test', slug: 'test-proj', description: 'x',
      directory: tmpDir, autoDecide: true,
    });
    const app = makeApp();
    const res = await request(app).get('/projects');
    expect(res.body.slugs).toContain('test-proj');
  });
});

describe('POST /notify', () => {
  it('broadcasts and returns ok for a registered slug', async () => {
    await projectStore.create({
      title: 'Test', slug: 'test-proj', description: 'x',
      directory: tmpDir, autoDecide: true,
    });
    const calls: Array<[string, string | undefined, string | undefined]> = [];
    const app = makeApp(undefined, {}, { broadcast: (text, slug, projectDirectory) => { calls.push([text, slug, projectDirectory]); } });

    const res = await request(app).post('/notify').send({ slug: 'test-proj', message: 'hello' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(calls).toEqual([['hello', 'test-proj', tmpDir]]);
  });

  it('returns 404 for an unregistered slug', async () => {
    const app = makeApp();
    const res = await request(app).post('/notify').send({ slug: 'nope', message: 'hi' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when slug or message is missing', async () => {
    const app = makeApp();
    const res1 = await request(app).post('/notify').send({ message: 'hi' });
    expect(res1.status).toBe(400);
    const res2 = await request(app).post('/notify').send({ slug: 'test-proj' });
    expect(res2.status).toBe(400);
  });
});

describe('POST /ask', () => {
  it('returns 200 with valid trigger', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/ask')
      .send({
        trigger: {
          sender: 'Test', query: 'hello', type: 'inline',
          replyTo: null, originalMessage: '/demo hello',
        },
        recentMessages: [],
      });

    expect(res.status).toBe(200);
    expect(res.body.response).toBe('Test response');
    expect(res.body.timestamp).toBeDefined();
  });

  it('returns 400 when trigger is missing', async () => {
    const app = makeApp();
    const res = await request(app).post('/ask').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('trigger');
  });

  it('returns 429 when rate limited', async () => {
    const app = makeApp(undefined, { maxRequestsPerMinute: 1 });

    await request(app)
      .post('/ask')
      .send({
        trigger: { sender: 'A', type: 'inline', query: null, replyTo: null, originalMessage: '/demo' },
        recentMessages: [],
      });

    const res = await request(app)
      .post('/ask')
      .send({
        trigger: { sender: 'B', type: 'inline', query: null, replyTo: null, originalMessage: '/demo two' },
        recentMessages: [],
      });

    expect(res.status).toBe(429);
  });

  it('returns 500 when router throws', async () => {
    const failingRouter = {
      handle: async () => { throw new Error('API error'); },
    } as unknown as CommandRouter;
    const app = makeApp(failingRouter);

    const res = await request(app)
      .post('/ask')
      .send({
        trigger: { sender: 'Test', type: 'inline', query: 'test', replyTo: null, originalMessage: '/demo test' },
        recentMessages: [],
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Technical issue');
  });

  it('tracks stats after successful requests', async () => {
    const app = makeApp();

    await request(app)
      .post('/ask')
      .send({
        trigger: { sender: 'X', type: 'inline', query: 'test', replyTo: null, originalMessage: '/demo test' },
        recentMessages: [],
      });

    const health = await request(app).get('/health');
    expect(health.body.stats.requestsServed).toBe(1);
    expect(health.body.stats.avgResponseMs).toBeGreaterThanOrEqual(0);
  });
});

describe('GET /usage', () => {
  it('returns the Muse usage snapshot (null before any run)', async () => {
    const res = await request(makeApp()).get('/usage');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('muse');
  });
});

// Helper: parse SSE text into typed events
function parseSSE(body: string): { type: string; [k: string]: unknown }[] {
  return body
    .split('\n')
    .filter(l => l.startsWith('data: '))
    .map(l => JSON.parse(l.slice(6)));
}

describe('POST /ask/stream', () => {
  it('streams message events and done', async () => {
    const router = {
      handle: async (_payload: unknown, onMessage?: (t: string) => void) => {
        onMessage?.('Hello from Muse');
        return { response: 'Hello from Muse' };
      },
    } as unknown as CommandRouter;

    const res = await request(makeApp(router))
      .post('/ask/stream')
      .send({ trigger: { type: 'text', sender: 'user', originalMessage: '/test', replyTo: null } });

    const events = parseSSE(res.text);
    const msgEvents = events.filter(e => e.type === 'message');
    const doneEvent = events.find(e => e.type === 'done');

    expect(msgEvents.length).toBeGreaterThan(0);
    expect(msgEvents[0].text).toBe('Hello from Muse');
    expect(doneEvent).toBeDefined();
  });

  it('streams subagent attribution on tool events and a separate agent_done event', async () => {
    const router = {
      handle: async (_p: unknown, _m: unknown, onToolUse?: (n: string, d: string, meta?: unknown) => void) => {
        onToolUse?.('Bash', 'echo hi', { id: 'toolu_X', parentId: 'toolu_A' });
        onToolUse?.('Agent', '', { id: 'toolu_A', done: true });
        return { response: 'ok' };
      },
    } as unknown as CommandRouter;

    const res = await request(makeApp(router))
      .post('/ask/stream')
      .send({ trigger: { type: 'text', sender: 'user', originalMessage: '/test', replyTo: null } });

    const events = parseSSE(res.text);
    expect(events.find(e => e.type === 'tool')).toMatchObject({ name: 'Bash', detail: 'echo hi', id: 'toolu_X', parentId: 'toolu_A' });
    expect(events.find(e => e.type === 'agent_done')).toMatchObject({ id: 'toolu_A' });
    expect(events.filter(e => e.type === 'tool')).toHaveLength(1);
  });

  it('streams subagent text with its parentId, dedups per speaker, and still sends a main-less reply single-shot', async () => {
    const router = {
      handle: async (_p: unknown, onMessage?: (t: string, meta?: { parentId: string }) => void) => {
        onMessage?.('same words', { parentId: 'toolu_A' });
        onMessage?.('same words', { parentId: 'toolu_A' }); // dup from the same agent → dropped
        onMessage?.('same words', { parentId: 'toolu_B' }); // another agent → kept
        return { response: 'final answer' };
      },
    } as unknown as CommandRouter;

    const res = await request(makeApp(router))
      .post('/ask/stream')
      .send({ trigger: { type: 'text', sender: 'user', originalMessage: '/test', replyTo: null } });

    const events = parseSSE(res.text);
    expect(events.filter(e => e.type === 'message')).toEqual([
      { type: 'message', text: 'same words', parentId: 'toolu_A' },
      { type: 'message', text: 'same words', parentId: 'toolu_B' },
    ]);
    // Only subagent text streamed → the main reply wasn't, so the client must render `response`.
    expect(events.find(e => e.type === 'done')).toMatchObject({ response: 'final answer', singleShot: true });
  });

  it('forwards CLI spawn summaries for the trigger slug as cli_params events and unsubscribes after', async () => {
    const listeners = new Map<string, (line: string) => void>();
    let unsubscribed = false;
    const sessionManager = {
      onSpawn: (slug: string, fn: (line: string) => void) => {
        listeners.set(slug, fn);
        return () => { unsubscribed = true; };
      },
    } as unknown as SessionManager;
    const router = {
      handle: async () => {
        listeners.get('test')?.('muse exec --json --yolo --session-id 01234567');
        return { response: 'ok' };
      },
    } as unknown as CommandRouter;

    const app = makeApp(router, {}, { sessionManager });
    const res = await request(app)
      .post('/ask/stream')
      .send({ trigger: { type: 'text', sender: 'user', originalMessage: '/test go', replyTo: null } });

    const ev = parseSSE(res.text).find(e => e.type === 'cli_params');
    expect(ev?.text).toBe('muse exec --json --yolo --session-id 01234567');
    expect(unsubscribed).toBe(true);
  });

  it('keeps heartbeating a long-running stream (timer must outlive the request body)', async () => {
    const router = {
      handle: async () => {
        await new Promise(r => setTimeout(r, 250));
        return { response: 'ok' };
      },
    } as unknown as CommandRouter;
    const app = makeApp(router, {}, { streamHeartbeatMs: 20 });
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/ask/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger: { type: 'text', sender: 'user', originalMessage: '/test', replyTo: null } }),
      });
      const text = await res.text();
      expect((text.match(/: heartbeat/g) ?? []).length).toBeGreaterThanOrEqual(3);
    } finally {
      server.close();
    }
  });

  it('deduplicates parts when stripJsonParts returns duplicate content', async () => {
    // Simulate the agent returning prefix text that matches the JSON message
    const jsonResponse = '{"tldr": "Task done.", "decision": {"summary": "continue", "rating": 0}}';
    const router = {
      handle: async (_payload: unknown, onMessage?: (t: string) => void) => {
        // This raw text has prefix matching the JSON message — would produce duplicate parts
        onMessage?.(`Task done.\n\n${jsonResponse}`);
        return { response: 'Task done.' };
      },
    } as unknown as CommandRouter;

    const res = await request(makeApp(router))
      .post('/ask/stream')
      .send({ trigger: { type: 'text', sender: 'user', originalMessage: '/test', replyTo: null } });

    const events = parseSSE(res.text);
    const msgEvents = events.filter(e => e.type === 'message');

    // "Task done." should only appear once despite stripJsonParts returning it twice
    const taskDoneCount = msgEvents.filter(e => e.text === 'Task done.').length;
    expect(taskDoneCount).toBe(1);
  });

  it('sets singleShot=false on done when messages were already streamed', async () => {
    const router = {
      handle: async (_payload: unknown, onMessage?: (t: string) => void) => {
        onMessage?.('Some streamed content');
        return { response: 'Some streamed content' };
      },
    } as unknown as CommandRouter;

    const res = await request(makeApp(router))
      .post('/ask/stream')
      .send({ trigger: { type: 'text', sender: 'user', originalMessage: '/test', replyTo: null } });

    const events = parseSSE(res.text);
    const doneEvent = events.find(e => e.type === 'done');
    expect(doneEvent?.singleShot).toBe(false);
  });

  it('sets singleShot=true on done when nothing was streamed', async () => {
    const router = {
      handle: async () => ({ response: 'Static response' }),
    } as unknown as CommandRouter;

    const res = await request(makeApp(router))
      .post('/ask/stream')
      .send({ trigger: { type: 'text', sender: 'user', originalMessage: '/list', replyTo: null } });

    const events = parseSSE(res.text);
    const doneEvent = events.find(e => e.type === 'done');
    expect(doneEvent?.singleShot).toBe(true);
    expect(doneEvent?.response).toBe('Static response');
  });

  it('returns 429 when RPM limit exceeded on stream endpoint', async () => {
    const router = {
      handle: async () => ({ response: 'ok' }),
    } as unknown as CommandRouter;
    const app = makeApp(router, { maxRequestsPerMinute: 1 });

    const trigger = { type: 'inline', sender: 'X', originalMessage: '/test', replyTo: null };
    const r1 = await request(app).post('/ask/stream').send({ trigger });
    expect(r1.status).toBe(200);

    const r2 = await request(app).post('/ask/stream').send({ trigger });
    expect(r2.status).toBe(429);
  });

  it('RPM counter is shared between /ask and /ask/stream', async () => {
    const router = {
      handle: async () => ({ response: 'ok' }),
    } as unknown as CommandRouter;
    const app = makeApp(router, { maxRequestsPerMinute: 1 });

    const trigger = { type: 'inline', sender: 'X', originalMessage: '/test', replyTo: null };
    const r1 = await request(app).post('/ask').send({ trigger });
    expect(r1.status).toBe(200);

    // Second request to /ask/stream should be rate-limited by shared counter
    const r2 = await request(app).post('/ask/stream').send({ trigger });
    expect(r2.status).toBe(429);
  });

  it('emits error event when handler throws', async () => {
    const router = {
      handle: async () => { throw new Error('Something went wrong'); },
    } as unknown as CommandRouter;

    const res = await request(makeApp(router))
      .post('/ask/stream')
      .send({ trigger: { type: 'text', sender: 'user', originalMessage: '/test', replyTo: null } });

    const events = parseSSE(res.text);
    const errEvent = events.find(e => e.type === 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent?.error).toContain('Something went wrong');
  });

  it('emits aborted event when handler throws with "aborted"', async () => {
    const router = {
      handle: async () => { throw new Error('Request aborted by client'); },
    } as unknown as CommandRouter;

    const res = await request(makeApp(router))
      .post('/ask/stream')
      .send({ trigger: { type: 'text', sender: 'user', originalMessage: '/test', replyTo: null } });

    const events = parseSSE(res.text);
    const abortEvent = events.find(e => e.type === 'aborted');
    expect(abortEvent).toBeDefined();
  });
});

describe('origin guard', () => {
  it('rejects requests from web pages, allows no-Origin clients and configured origins', async () => {
    const app = makeApp(undefined, { allowedOrigins: ['https://allowed.example'] });
    expect((await request(app).post('/ask').set('Origin', 'https://evil.example').send({})).status).toBe(403);
    expect((await request(app).get('/health').set('Origin', 'http://localhost:8080')).status).toBe(403);
    expect((await request(app).get('/health')).status).toBe(200);
    const ok = await request(app).get('/health').set('Origin', 'https://allowed.example');
    expect(ok.status).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe('https://allowed.example');
  });
});

describe('bearer token', () => {
  it('requires the token everywhere except /health', async () => {
    const app = makeApp(undefined, { token: 's3cret' });
    expect((await request(app).get('/health')).status).toBe(200);
    expect((await request(app).get('/projects')).status).toBe(401);
    expect((await request(app).get('/projects').set('Authorization', 'Bearer wrong')).status).toBe(401);
    expect((await request(app).get('/projects').set('Authorization', 'Bearer s3cret')).status).toBe(200);
  });
});

describe('trigger sender default', () => {
  it('fills in the configured sender name when the client sends none', async () => {
    let sender: string | undefined;
    const router = { handle: async (p: { trigger: { sender?: string } }) => { sender = p.trigger.sender; return { response: 'ok' }; } } as unknown as CommandRouter;
    await request(makeApp(router, { senderName: 'pilot' })).post('/ask').send({ trigger: { type: 'inline', originalMessage: '/list', replyTo: null } });
    expect(sender).toBe('pilot');
  });
});

describe('POST /ask/stream payload guard', () => {
  it('rejects a trigger whose originalMessage is not a string instead of crashing', async () => {
    const app = makeApp();
    const res = await request(app).post('/ask/stream').send({ trigger: { originalMessage: 42 }, recentMessages: [] });
    expect(res.status).toBe(400);
  });
});
