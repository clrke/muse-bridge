import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter, PassThrough } from 'node:stream';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
import { spawn } from 'node:child_process';
import { MspClient, MspError, uuidv7 } from '../src/msp-client.js';

// Wire shapes recorded live from `muse serve` 1.4.14 (spike 2026-11-08).
const UUIDv7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

let spawns: { cmd: string; args: string[]; env: Record<string, string> }[];
function fakeServe() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(),
  });
  const chunks: string[] = [];
  proc.stdin.on('data', (d: Buffer) => chunks.push(d.toString('utf-8')));
  vi.mocked(spawn).mockImplementationOnce(((cmd: string, args: string[], opts: { env: Record<string, string> }) => {
    spawns.push({ cmd, args, env: opts.env });
    return proc as any;
  }) as any);
  return {
    proc,
    /** Everything the client wrote, parsed per line. */
    sent: () => chunks.join('').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)),
    /** Feed stdout lines to the client. */
    lines: (...objs: object[]) => proc.stdout.write(objs.map((o) => JSON.stringify(o)).join('\n') + '\n'),
  };
}

async function started(extra: Record<string, unknown> = {}) {
  const c = new MspClient({ musePath: '/opt/bin/muse', envPassthrough: ['GH_TOKEN'], ...extra });
  const f = fakeServe();
  const p = c.start();
  await tick();
  const [init] = f.sent();
  expect(init.method).toBe('initialize');
  f.lines({ jsonrpc: '2.0', id: init.id, result: { serverInfo: { name: 'muse' }, experimentalApi: false } });
  await p;
  await tick();
  return { c, f };
}

describe('uuidv7', () => {
  it('mints version-7, variant-10 ids that sort by time', () => {
    const a = uuidv7();
    expect(a).toMatch(UUIDv7_RE);
  });
});

describe('MspClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawns = [];
    process.env.BRIDGE_TOKEN = 'secret';
    process.env.GH_TOKEN = 'passthrough-me';
  });

  it('spawns serve with workspace trust and a scrubbed env, then handshakes', async () => {
    const { f } = await started();
    expect(spawns).toHaveLength(1);
    expect(spawns[0].cmd).toBe('/opt/bin/muse');
    expect(spawns[0].args).toEqual(['serve', '--trust-workspace']);
    expect(spawns[0].env.BRIDGE_TOKEN).toBeUndefined();
    expect(spawns[0].env.GH_TOKEN).toBeDefined(); // passthrough survives

    const sent = f.sent();
    expect(sent[0]).toMatchObject({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { clientInfo: { name: 'muse_bridge', version: '0.1.0' } },
    });
    expect(sent[1]).toEqual({ jsonrpc: '2.0', method: 'initialized', params: {} });
    expect(sent[0].params.clientInfo.name).toMatch(/^[a-z0-9_]+$/); // host SS1.4.1 rule
  });

  it('start() is idempotent while the host lives', async () => {
    const { c } = await started();
    await c.start();
    expect(spawns).toHaveLength(1);
    expect(c.closed).toBe(false);
  });

  it('refuses a host demanding experimentalApi', async () => {
    const c = new MspClient({ musePath: '/opt/bin/muse' });
    const f = fakeServe();
    const p = c.start();
    await tick();
    const [init] = f.sent();
    f.lines({ jsonrpc: '2.0', id: init.id, result: { experimentalApi: true } });
    await expect(p).rejects.toThrow(MspError);
  });

  it('routes responses by id and mints uuidv7 commandIds', async () => {
    const { c, f } = await started();
    const p1 = c.request('session/start', { commandId: uuidv7() });
    const p2 = c.request('approval/listPending', { sessionId: 's' });
    await tick();
    const sent = f.sent().slice(2); // after initialize + initialized
    expect(sent.map((m: any) => m.method)).toEqual(['session/start', 'approval/listPending']);
    expect(sent.map((m: any) => m.id)).toEqual([2, 3]);
    // Out-of-order replies still land on the right caller.
    f.lines({ jsonrpc: '2.0', id: 3, result: { approvals: [] } });
    f.lines({ jsonrpc: '2.0', id: 2, result: { session: { sessionId: 's' } } });
    await expect(p2).resolves.toEqual({ approvals: [] });
    await expect(p1).resolves.toEqual({ session: { sessionId: 's' } });
  });

  it('surfaces rejections as MspError with kind/reason/retryable', async () => {
    const { c, f } = await started();
    const p = c.request('turn/interrupt', {});
    await tick();
    const [req] = f.sent().slice(2);
    f.lines({
      jsonrpc: '2.0', id: req.id,
      error: { code: -32030, message: 'rejected: missing_run', data: { kind: 'commandRejected', reason: 'missing_run', retryable: false } },
    });
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(MspError);
    expect(err.code).toBe(-32030);
    expect(err.kind).toBe('commandRejected');
    expect(err.reason).toBe('missing_run');
    expect(err.retryable).toBe(false);
  });

  it('fans out view events and answers server requests via respond()', async () => {
    const { c, f } = await started();
    const seen: any[] = [];
    const off = c.onEvent((e) => seen.push(e));
    f.lines(
      { jsonrpc: '2.0', method: 'item/delta', params: { delta: 'hi' } },
      { jsonrpc: '2.0', id: 99, method: 'approval/request', params: { approvalId: 'a' } },
    );
    await tick(20);
    expect(seen).toEqual([
      { method: 'item/delta', params: { delta: 'hi' } },
      { method: 'approval/request', params: { approvalId: 'a' }, id: 99 },
    ]);
    c.respond(99, {});
    await tick();
    const last = f.sent().at(-1);
    expect(last).toEqual({ jsonrpc: '2.0', id: 99, result: {} });
    off();
  });

  it('ignores non-JSON stdout noise', async () => {
    const { c, f } = await started();
    const seen: any[] = [];
    c.onEvent((e) => seen.push(e));
    f.proc.stdout.write('some log line\n');
    f.lines({ jsonrpc: '2.0', method: 'turn/completed', params: { terminal: 'completed' } });
    await tick(20);
    expect(seen).toEqual([{ method: 'turn/completed', params: { terminal: 'completed' } }]);
  });

  it('sends the session/turn/approval/leave verbs with the recorded shapes', async () => {
    const { c, f } = await started();
    const calls: [string, Promise<any>][] = [
      ['session/start', c.startSession('/private/tmp/w', 'promptUnmatched')],
      ['session/resume', c.resumeSession('s')],
      ['session/setApprovalMode', c.setApprovalMode('s', 'denyUnmatched')],
      ['turn/start', c.startTurn('s', 'do it', { reasoningEffort: 'high', workspaceRoot: '/private/tmp/w' })],
      ['turn/interrupt', c.interrupt('s', 't')],
      ['approval/listPending', c.listPending('s')],
      ['approval/decide', c.decideApproval({ sessionId: 's', approvalId: 'a', choiceId: 'reject', requirementId: { approvalId: 'a', sourceIndex: 0 } })],
      ['session/leave', c.leave('s')],
    ];
    await tick();
    const sent = f.sent().slice(2);
    expect(sent.map((m: any) => m.method)).toEqual(calls.map(([m]) => m));
    for (const m of sent) expect(m.params.commandId ?? 'n/a').toMatch(/^(n\/a|[0-9a-f-]{36})$/);
    expect(sent[0].params).toMatchObject({ approvalMode: 'promptUnmatched', workspaceRoots: ['/private/tmp/w'] });
    expect(sent[1].params).toMatchObject({ sessionId: 's', excludeItems: true });
    expect(sent[2].params).toMatchObject({ sessionId: 's', mode: 'denyUnmatched' });
    expect(sent[3].params).toMatchObject({
      sessionId: 's', input: [{ type: 'text', text: 'do it' }],
      reasoningEffort: 'high', workspaceRoots: ['/private/tmp/w'],
    });
    expect(sent[4].params).toMatchObject({ sessionId: 's', turnId: 't' });
    expect(sent[5].params).toEqual({ sessionId: 's' });
    expect(sent[6].params).toMatchObject({ sessionId: 's', approvalId: 'a', choiceId: 'reject' });
    expect(sent[7].params).toMatchObject({ sessionId: 's', stop: true });
    sent.forEach((m: any, i: number) => f.lines({ jsonrpc: '2.0', id: m.id, result: { ok: i } }));
    for (const [, p] of calls) await p;
  });

  it('rejects requests that outlive their timeout', async () => {
    const { c } = await started({ requestTimeoutMs: 20 });
    await expect(c.request('session/list', {})).rejects.toThrow(/timed out/);
  });

  it('fails pending requests and fires onClose when the host dies', async () => {
    const { c, f } = await started();
    const closed: any[] = [];
    c.onClose((info) => closed.push(info));
    const p = c.request('session/list', {});
    f.proc.emit('close', 1, null);
    await expect(p).rejects.toThrow(/exited/);
    expect(closed).toEqual([{ code: 1, signal: null }]);
    expect(c.closed).toBe(true);
    await expect(c.request('session/list', {})).rejects.toThrow(/closed/);
  });

  it('close() ends stdin, SIGTERMs, and resolves once gone', async () => {
    const { c, f } = await started();
    const p = c.close();
    await tick();
    expect(f.proc.kill).toHaveBeenCalledWith('SIGTERM');
    f.proc.emit('close', 0, null);
    await p;
    expect(c.closed).toBe(true);
  });
});
