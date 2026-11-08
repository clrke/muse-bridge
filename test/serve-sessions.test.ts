import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter, PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
import { spawn } from 'node:child_process';
import { ServeSessionManager } from '../src/serve-sessions.js';
import { STOPPED_BY_USER } from '../src/session-manager.js';
import { getMuseUsage, resetMuseUsage } from '../src/muse-usage.js';

// Scripted `muse serve` hosts; wire shapes recorded live from 1.4.14.
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

interface Fake {
  proc: any;
  cmd: string;
  args: string[];
  env: Record<string, string>;
  answered: Set<number>;
  sent: () => any[];
  lines: (...objs: object[]) => void;
}
let fakes: Fake[];
function makeFake(cmd: string, args: string[], opts: { env: Record<string, string> }): Fake {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(),
  });
  let buf = '';
  const out: any[] = [];
  proc.stdin.on('data', (d: Buffer) => {
    buf += d.toString('utf-8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) out.push(JSON.parse(line));
    }
  });
  const f: Fake = {
    proc, cmd, args, env: opts.env, answered: new Set(),
    sent: () => out,
    lines: (...objs: object[]) => proc.stdout.write(objs.map((o) => JSON.stringify(o)).join('\n') + '\n'),
  };
  fakes.push(f);
  return f;
}

/** Reply to the next unanswered request with `method`; fails when none arrives. */
async function replyTo(f: Fake, method: string, result: any) {
  for (let i = 0; i < 400; i++) {
    const m = f.sent().find((m) => m.method === method && m.id !== undefined && !f.answered.has(m.id));
    if (m) {
      f.answered.add(m.id);
      f.lines({ jsonrpc: '2.0', id: m.id, result });
      return m;
    }
    await tick(5);
  }
  throw new Error(`timed out waiting for ${method}`);
}

/** Finish a turn with one text line so no query dangles past its test. */
async function completeTurn(f: Fake, sessionId: string, turnId: string, text = 'ok') {
  await replyTo(f, 'turn/start', { turnId, status: 'accepted' });
  f.lines({ jsonrpc: '2.0', method: 'item/delta', params: { itemId: 'm', delta: text } });
  f.lines({ jsonrpc: '2.0', method: 'turn/completed', params: { sessionId, turnId, terminal: 'completed' } });
}

async function handshake(f: Fake) {
  await replyTo(f, 'initialize', { serverInfo: { name: 'muse' }, experimentalApi: false });
  await tick();
}

const bashItem = (extra: object = {}) => ({
  itemId: 'i1', kind: 'toolCall', turnId: 't1', revision: 3, status: 'completed',
  recordedAt: '2026-11-08T01:54:16.138929Z', tool: 'bash', callId: 'call_1',
  args: JSON.stringify({ command: 'pwd' }),
  visibleOutput: JSON.stringify({ command: 'pwd', exit_code: 0, output: '/w\n' }), ...extra,
});

describe('ServeSessionManager', () => {
  let sm: ServeSessionManager;
  beforeEach(() => {
    vi.clearAllMocks();
    fakes = [];
    resetMuseUsage();
    process.env.BRIDGE_TOKEN = 'secret';
    vi.mocked(spawn).mockImplementation(((cmd: string, args: string[], opts: any) => makeFake(cmd, args, opts).proc) as any);
    sm = new ServeSessionManager({ musePath: '/opt/bin/muse', envPassthrough: [] });
  });

  async function queryWithScript(slug: string, prompt: string, opts: any, script: (f: Fake) => Promise<void>) {
    const onMessage = vi.fn();
    const onToolUse = vi.fn();
    const onApproval = vi.fn();
    const p = sm.query(slug, prompt, { ...opts, onMessage, onToolUse, onApproval });
    await tick();
    await script(fakes[fakes.length - 1]);
    return { result: await p, onMessage, onToolUse, onApproval };
  }

  it('runs a turn on a serve host and folds view events into the query contract', async () => {
    const { result, onMessage, onToolUse, onApproval } = await queryWithScript(
      'bots', 'do it', { cwd: '/work/bots', systemPrompt: 'SYS', effort: 'high' }, async (f) => {
        await handshake(f);
        const start = await replyTo(f, 'session/start', { session: { sessionId: 's1' }, viewCursor: 'c' });
        expect(start.params).toMatchObject({ approvalMode: 'promptUnmatched', workspaceRoots: ['/work/bots'] });
        const turn = await replyTo(f, 'turn/start', { turnId: 't1', status: 'accepted' });
        expect(turn.params.input).toEqual([{ type: 'text', text: 'SYS\n\n---\ndo it' }]);
        expect(turn.params.displayText).toBe('do it');
        expect(turn.params.reasoningEffort).toBe('high');
        expect(turn.params.workspaceRoots).toEqual(['/work/bots']);
        f.lines(
          { jsonrpc: '2.0', method: 'item/delta', params: { itemId: 'm', delta: 'Looking.' } },
          { jsonrpc: '2.0', method: 'item/started', params: { item: { kind: 'toolCall', itemId: 'i1' } } },
          { jsonrpc: '2.0', method: 'item/completed', params: { item: bashItem() } },
          {
            jsonrpc: '2.0', method: 'approval/resolved',
            params: { approvalId: 'a', decision: 'approved', resolvedBy: 'llmJudge', policyResult: 'allow' },
          },
          {
            jsonrpc: '2.0', method: 'session/tokenUsage',
            params: { sessionId: 's1', turnId: 't1', modelId: 'm', usage: { inputTokens: 10, cachedTokens: 2, outputTokens: 5 } },
          },
          { jsonrpc: '2.0', method: 'item/completed', params: { item: { kind: 'agentMessage', itemId: 'm', text: '{"tldr":"ok"}' } } },
          { jsonrpc: '2.0', method: 'turn/completed', params: { sessionId: 's1', turnId: 't1', terminal: 'completed' } },
        );
      },
    );

    expect(fakes).toHaveLength(1);
    expect(fakes[0].cmd).toBe('/opt/bin/muse');
    expect(fakes[0].args).toEqual(['serve', '--trust-workspace']);
    expect(fakes[0].env.BRIDGE_TOKEN).toBeUndefined();
    expect(result).toEqual({
      text: '{"tldr":"ok"}',
      messages: ['Looking.', '{"tldr":"ok"}'],
      toolsUsed: ['Bash'],
      sessionId: 's1',
    });
    expect(onMessage.mock.calls.map((c) => c[0])).toEqual(['Looking.', '{"tldr":"ok"}']);
    expect(onToolUse).toHaveBeenCalledWith('Bash', 'pwd', { parentId: null });
    expect(onApproval).toHaveBeenCalledWith(expect.objectContaining({ decision: 'approved', resolvedBy: 'llmJudge' }));
    expect(getMuseUsage().today.calls).toBe(1);
    expect(getMuseUsage().today.inputTokens).toBe(10);
  });

  it('reuses one session across turns on the same host', async () => {
    const once = (text: string) =>
      queryWithScript('bots', text, { cwd: '/w' }, async (f) => {
        await handshake(f);
        await replyTo(f, 'session/start', { session: { sessionId: 's1' }, viewCursor: 'c' });
        await replyTo(f, 'turn/start', { turnId: 't1', status: 'accepted' });
        f.lines({ jsonrpc: '2.0', method: 'turn/completed', params: { sessionId: 's1', turnId: 't1', terminal: 'completed' } });
      }).catch(() => null); // empty text rejects; the sends still happened
    await once('one');
    const p = sm.query('bots', 'two', { cwd: '/w' });
    await tick(30);
    const f = fakes[0];
    // No re-resume: the session is already loaded on this host; only the
    // mode is re-applied before the turn starts.
    const mode = await replyTo(f, 'session/setApprovalMode', { applyOutcome: 'noop' });
    expect(mode.params).toMatchObject({ sessionId: 's1', mode: 'promptUnmatched' });
    await replyTo(f, 'turn/start', { turnId: 't2', status: 'accepted' });
    f.lines({ jsonrpc: '2.0', method: 'item/delta', params: { itemId: 'm', delta: 'two!' } });
    f.lines({ jsonrpc: '2.0', method: 'turn/completed', params: { sessionId: 's1', turnId: 't2', terminal: 'completed' } });
    const r = await p;

    expect(fakes).toHaveLength(1); // one host, still
    expect(f.sent().filter((m: any) => m.method === 'session/start')).toHaveLength(1);
    expect(f.sent().filter((m: any) => m.method === 'session/resume')).toHaveLength(0);
    expect(f.sent().filter((m: any) => m.method === 'turn/start')).toHaveLength(2);
    expect(r.sessionId).toBe('s1');
    expect(r.text).toBe('two!');
  });

  it('resumes a loaded session, and starts fresh when resume fails', async () => {
    sm.loadSession('bots', 'persisted');
    const p = sm.query('bots', 'hi', { cwd: '/w' });
    await tick(30);
    const f = fakes[0];
    await handshake(f);
    const resume = await replyTo(f, 'session/resume', { session: { sessionId: 'persisted' }, viewCursor: 'c' });
    expect(resume.params).toMatchObject({ sessionId: 'persisted', excludeItems: true });
    expect(sm.getSessionId('bots')).toBe('persisted');
    await replyTo(f, 'session/setApprovalMode', { applyOutcome: 'noop' });
    await completeTurn(f, 'persisted', 't1');
    await p;

    // Second slug whose stored id is stale on the host.
    sm.loadSession('web', 'gone');
    const p2 = sm.query('web', 'hi', { cwd: '/w' });
    await tick(30);
    const f2 = fakes[1];
    await handshake(f2);
    for (let i = 0; i < 400; i++) {
      const m = f2.sent().find((m) => m.method === 'session/resume');
      if (m) {
        f2.lines({ jsonrpc: '2.0', id: m.id, error: { code: -32011, message: 'gone', data: { kind: 'notFound' } } });
        break;
      }
      await tick(5);
    }
    await replyTo(f2, 'session/start', { session: { sessionId: 'fresh' }, viewCursor: 'c' });
    await tick(30); // let the reply land before reading driver state
    expect(sm.getSessionId('web')).toBe('fresh');
    await completeTurn(f2, 'fresh', 't2');
    await p2;
  });

  it('resetSession leaves the session and starts fresh next turn', async () => {
    await queryWithScript('bots', 'one', { cwd: '/w' }, async (f) => {
      await handshake(f);
      await replyTo(f, 'session/start', { session: { sessionId: 's1' }, viewCursor: 'c' });
      await replyTo(f, 'turn/start', { turnId: 't1', status: 'accepted' });
      f.lines({ jsonrpc: '2.0', method: 'item/delta', params: { itemId: 'm', delta: 'x' } });
      f.lines({ jsonrpc: '2.0', method: 'turn/completed', params: { sessionId: 's1', turnId: 't1', terminal: 'completed' } });
    });
    sm.resetSession('bots');
    expect(sm.getSessionId('bots')).toBeUndefined();
    const p = sm.query('bots', 'two', { cwd: '/w' });
    await tick(30);
    const f = fakes[0];
    await replyTo(f, 'session/leave', { ok: true });
    await replyTo(f, 'session/start', { session: { sessionId: 's2' }, viewCursor: 'c' });
    await tick(30); // let the reply land before reading driver state
    expect(sm.getSessionId('bots')).toBe('s2');
    await completeTurn(f, 's2', 't2');
    await p;
  });

  it('stop() interrupts the turn and reports STOPPED_BY_USER, keeping the session', async () => {
    const p = sm.query('bots', 'slow', { cwd: '/w' });
    p.catch(() => {});
    await tick(30);
    const f = fakes[0];
    await handshake(f);
    await replyTo(f, 'session/start', { session: { sessionId: 's1' }, viewCursor: 'c' });
    await replyTo(f, 'turn/start', { turnId: 't1', status: 'accepted' });
    await tick(20);
    expect(sm.isRunning('bots')).toBe(true);
    const r = sm.stop('bots');
    expect(r.stopped).toBe(true);
    await tick(20);
    const intr = f.sent().find((m: any) => m.method === 'turn/interrupt');
    expect(intr.params).toMatchObject({ sessionId: 's1', turnId: 't1' });
    f.proc.emit('close', null, 'SIGTERM'); // escalated kill lands
    await expect(p).rejects.toThrow(STOPPED_BY_USER);
    expect(sm.getSessionId('bots')).toBe('s1'); // the conversation survives the stop
    expect(sm.isRunning('bots')).toBe(false);
    expect(sm.stop('bots').stopped).toBe(false); // nothing left to stop
  });

  it('selects denyUnmatched fail-closed for readOnly, noTools, and disallowedTools', async () => {
    const cases: [string, { readOnly?: boolean; noTools?: boolean; disallowedTools?: string[] }][] = [
      ['a', { readOnly: true }],
      ['b', { noTools: true }],
      ['c', { disallowedTools: ['Bash'] }],
    ];
    for (const [slug, opts] of cases) {
      const p = sm.query(slug, 'x', { cwd: '/w', ...opts });
      p.catch(() => {});
      await tick(30);
      const f = fakes[fakes.length - 1];
      await handshake(f);
      const start = await replyTo(f, 'session/start', { session: { sessionId: 's' }, viewCursor: 'c' });
      expect(start.params.approvalMode).toBe('denyUnmatched');
      await completeTurn(f, 's', 't-' + slug);
      await p;
    }
  });

  it('rejects failed, cancelled, and empty turns like the exec driver', async () => {
    const run = async (terminal: string, extra: object, delta?: string) => {
      const p = sm.query('bots' + terminal, terminal, { cwd: '/w' });
      p.catch(() => {});
      await tick(30);
      const f = fakes[fakes.length - 1];
      await handshake(f);
      await replyTo(f, 'session/start', { session: { sessionId: 's' }, viewCursor: 'c' });
      await replyTo(f, 'turn/start', { turnId: 't', status: 'accepted' });
      if (delta) f.lines({ jsonrpc: '2.0', method: 'item/delta', params: { itemId: 'm', delta } });
      f.lines({ jsonrpc: '2.0', method: 'turn/completed', params: { sessionId: 's', turnId: 't', terminal, ...extra } });
      return p;
    };
    await expect(run('failed', { reason: 'boom' })).rejects.toThrow('Muse turn failed: boom');
    await expect(run('cancelled', {})).rejects.toThrow('Turn cancelled');
    await expect(run('completed', {})).rejects.toThrow('empty response');
    // But a failed turn that still produced text resolves with it.
    const p = sm.query('botspartial', 'failed', { cwd: '/w' });
    p.catch(() => {});
    await tick(30);
    const f = fakes[fakes.length - 1];
    await handshake(f);
    await replyTo(f, 'session/start', { session: { sessionId: 's' }, viewCursor: 'c' });
    await replyTo(f, 'turn/start', { turnId: 't', status: 'accepted' });
    f.lines({ jsonrpc: '2.0', method: 'item/delta', params: { itemId: 'm', delta: 'partial' } });
    f.lines({ jsonrpc: '2.0', method: 'turn/completed', params: { sessionId: 's', turnId: 't', terminal: 'failed', reason: 'x' } });
    await expect(p).resolves.toMatchObject({ text: 'partial' });
  });

  it('auto-denies judge escalations fail-closed so turns never hang unseen', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = sm.query('bots', 'risky', { cwd: '/w' });
    p.catch(() => {});
    await tick(30);
    const f = fakes[0];
    await handshake(f);
    await replyTo(f, 'session/start', { session: { sessionId: 's1' }, viewCursor: 'c' });
    await replyTo(f, 'turn/start', { turnId: 't1', status: 'accepted' });
    f.lines({
      jsonrpc: '2.0', id: 50, method: 'approval/request',
      params: {
        approvalId: 'a', currentRequirementId: { approvalId: 'a', sourceIndex: 0 },
        availableChoices: [{ choiceId: 'allow-once' }, { choiceId: 'reject' }],
      },
    });
    await tick(30);
    const decide = f.sent().find((m: any) => m.method === 'approval/decide');
    expect(decide.params).toMatchObject({ approvalId: 'a', choiceId: 'reject' });
    const ack = f.sent().find((m: any) => m.id === 50 && m.result !== undefined);
    expect(ack).toBeDefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    await replyTo(f, 'approval/decide', { terminal: true });
    f.lines({ jsonrpc: '2.0', method: 'item/delta', params: { itemId: 'm', delta: 'done' } });
    f.lines({ jsonrpc: '2.0', method: 'turn/completed', params: { sessionId: 's1', turnId: 't1', terminal: 'completed' } });
    await p;
  });

  it('rejects the turn when the host dies unexpectedly', async () => {
    const p = sm.query('bots', 'x', { cwd: '/w' });
    p.catch(() => {});
    await tick(30);
    const f = fakes[0];
    await handshake(f);
    await replyTo(f, 'session/start', { session: { sessionId: 's1' }, viewCursor: 'c' });
    await replyTo(f, 'turn/start', { turnId: 't1', status: 'accepted' });
    f.proc.emit('close', 1, null);
    await expect(p).rejects.toThrow(/exited/);
  });

  it('oneShot uses a fresh session per call and cleans up its workspace', async () => {
    let n = 0;
    const run = async () => {
      n++;
      const p = sm.oneShot('rank', { key: '(bridge)', timeoutMs: 5000 });
      await tick(30);
      const f = fakes[0]; // one host across calls; only the session is fresh
      if (n === 1) await handshake(f);
      else await replyTo(f, 'session/leave', { ok: true });
      const start = await replyTo(f, 'session/start', { session: { sessionId: 's' + n }, viewCursor: 'c' });
      expect(start.params.approvalMode).toBe('denyUnmatched');
      await replyTo(f, 'turn/start', { turnId: 't' + n, status: 'accepted' });
      f.lines({ jsonrpc: '2.0', method: 'item/delta', params: { itemId: 'm', delta: 'ranked' } });
      f.lines({ jsonrpc: '2.0', method: 'turn/completed', params: { sessionId: 'x', turnId: 't' + n, terminal: 'completed' } });
      return { text: await p, ws: start.params.workspaceRoots[0] as string };
    };
    const a = await run();
    const b = await run();
    expect(fakes).toHaveLength(1);
    expect(a.text).toBe('ranked');
    expect(a.ws).not.toBe(b.ws); // throwaway workspace per call
    expect(fs.existsSync(a.ws)).toBe(false);
    expect(fs.existsSync(b.ws)).toBe(false);
  });

  it('oneShot times out, stops the turn, and still cleans up', async () => {
    const p = sm.oneShot('slow', { key: '(bridge)', timeoutMs: 500 });
    await tick(30);
    const f = fakes[0];
    await handshake(f);
    await replyTo(f, 'session/start', { session: { sessionId: 's' }, viewCursor: 'c' });
    await replyTo(f, 'turn/start', { turnId: 't', status: 'accepted' });
    await tick(30); // let the ack land so the turn is genuinely in flight
    expect(sm.isRunning('(bridge)')).toBe(true);
    await expect(p).rejects.toThrow(/timed out/);
    await tick(20);
    expect(f.sent().some((m: any) => m.method === 'turn/interrupt')).toBe(true);
    const ws = f.sent().find((m: any) => m.method === 'session/start').params.workspaceRoots[0];
    expect(fs.existsSync(ws)).toBe(false);
  });

  it('sends canonical workspace roots (resolves /tmp symlinks)', async () => {
    const p = sm.query('bots', 'x', { cwd: os.tmpdir() });
    p.catch(() => {});
    await tick(30);
    const f = fakes[0];
    await handshake(f);
    const start = await replyTo(f, 'session/start', { session: { sessionId: 's' }, viewCursor: 'c' });
    expect(start.params.workspaceRoots).toEqual([fs.realpathSync(os.tmpdir())]);
    await completeTurn(f, 's', 't');
    await p;
  });

  it('closeAll leaves sessions and closes every host', async () => {
    const p = sm.query('bots', 'x', { cwd: '/w' });
    p.catch(() => {});
    await tick(30);
    const f = fakes[0];
    await handshake(f);
    await replyTo(f, 'session/start', { session: { sessionId: 's1' }, viewCursor: 'c' });
    await tick(30); // let the driver record the session before closing
    const closing = sm.closeAll();
    await tick(30);
    await replyTo(f, 'session/leave', { ok: true });
    for (let i = 0; i < 400 && f.proc.kill.mock.calls.length === 0; i++) await tick(5);
    f.proc.emit('close', 0, null);
    await closing;
    expect(f.sent().some((m: any) => m.method === 'session/leave')).toBe(true);
    expect(f.proc.kill).toHaveBeenCalledWith('SIGTERM');
    void p;
  });
});
