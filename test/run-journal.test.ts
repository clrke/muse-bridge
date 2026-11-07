import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { RunJournal } from '../src/run-journal.js';
import { createApp } from '../src/app.js';
import { ProjectStore } from '../src/project-store.js';
import type { CommandRouter } from '../src/command-router.js';
import type { SessionManager } from '../src/session-manager.js';

describe('RunJournal', () => {
  it('numbers events, replays after a seq, notifies live listeners and finishes on a terminal event', () => {
    const j = new RunJournal();
    const id = j.create('demo');
    const live: number[] = [];
    j.subscribe(id, (ev) => live.push(ev.seq));
    j.append(id, { type: 'message', text: 'a' });
    j.append(id, { type: 'message', text: 'b' });
    expect(j.since(id, 1).map(e => e.data.text)).toEqual(['b']);
    expect(j.isDone(id)).toBe(false);
    j.append(id, { type: 'done', response: 'r' });
    expect(j.isDone(id)).toBe(true);
    expect(live).toEqual([1, 2, 3]);
    expect(j.append(id, { type: 'message', text: 'late' })).toBeNull();
  });

  it('drops finished runs after the retention window, keeps running ones', () => {
    let now = 0;
    const j = new RunJournal(1_000, 100, () => now);
    const done = j.create(null);
    const running = j.create(null);
    j.append(done, { type: 'error', error: 'x' });
    now = 5_000;
    j.prune();
    expect(j.has(done)).toBe(false);
    expect(j.has(running)).toBe(true);
  });

  it('caps memory per run at maxEvents, keeping the newest', () => {
    const j = new RunJournal(1_000, 3);
    const id = j.create(null);
    for (let i = 0; i < 5; i++) j.append(id, { type: 'message', text: String(i) });
    expect(j.since(id, 0).map(e => e.seq)).toEqual([3, 4, 5]);
  });
});

function parseSSE(body: string) {
  return body.split('\n\n').filter(Boolean).map(block => {
    const id = block.match(/^id: (\d+)$/m)?.[1];
    const data = block.match(/^data: (.*)$/m)?.[1];
    return data ? { id: id ? Number(id) : undefined, ...JSON.parse(data) } : null;
  }).filter(Boolean) as { id?: number; type: string; [k: string]: unknown }[];
}

async function makeApp(handle: CommandRouter['handle'], runJournal: RunJournal) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runs-app-'));
  const projectStore = new ProjectStore(path.join(tmpDir, 'projects'));
  await projectStore.init();
  return createApp({
    commandRouter: { handle } as unknown as CommandRouter,
    projectStore,
    config: { token: undefined, allowedOrigins: [], maxRequestsPerMinute: 60, senderName: 'user' },
    sseClients: new Set(),
    broadcast: () => {},
    sessionManager: { onSpawn: () => () => {} } as unknown as SessionManager,
    runJournal,
  });
}

const ask = { trigger: { type: 'text', sender: 'user', originalMessage: '/test hi', replyTo: null } };

describe('/ask/stream run journal + GET /runs/:id/events', () => {
  it('tags the stream with a run id and sequence ids; a finished run replays after N and ends', async () => {
    const journal = new RunJournal();
    const app = await makeApp((async (_p: unknown, onMessage?: (t: string) => void) => {
      onMessage?.('one');
      onMessage?.('two');
      return { response: 'final' };
    }) as unknown as CommandRouter['handle'], journal);

    const events = parseSSE((await request(app).post('/ask/stream').send(ask)).text);
    expect(events[0]).toMatchObject({ id: 1, type: 'run' });
    expect(events.map(e => e.id)).toEqual(events.map((_, i) => i + 1));
    const runId = events[0].runId as string;

    const replay = parseSSE((await request(app).get(`/runs/${runId}/events?after=2`)).text);
    expect(replay.map(e => [e.id, e.type, e.text ?? e.response])).toEqual([[3, 'message', 'two'], [4, 'done', 'final']]);
  });

  it('a resume attached mid-run gets the missed events, then live ones until done', async () => {
    const journal = new RunJournal();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let runId = '';
    const create = journal.create.bind(journal);
    journal.create = (slug) => (runId = create(slug));
    const app = await makeApp((async (_p: unknown, onMessage?: (t: string) => void) => {
      onMessage?.('before drop');
      await gate;
      onMessage?.('after resume');
      return { response: 'final' };
    }) as unknown as CommandRouter['handle'], journal);

    const original = request(app).post('/ask/stream').send(ask).then(r => r);
    while (!runId || journal.since(runId, 0).length < 2) await new Promise(r => setTimeout(r, 5));
    const resumed = request(app).get(`/runs/${runId}/events?after=1`).then(r => r);
    await new Promise(r => setTimeout(r, 30));
    release();
    const events = parseSSE((await resumed).text);
    expect(events.map(e => e.text ?? e.type)).toEqual(['before drop', 'after resume', 'done']);
    await original;
  });

  it('404s for unknown or expired runs', async () => {
    const app = await makeApp((async () => ({ response: 'x' })) as unknown as CommandRouter['handle'], new RunJournal());
    expect((await request(app).get('/runs/nope/events')).status).toBe(404);
  });
});
