import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter, Readable, PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
import { spawn } from 'node:child_process';
import { SessionManager, cleanEnv } from '../src/session-manager.js';
import { getMuseUsage, resetMuseUsage } from '../src/muse-usage.js';

// Event shapes recorded from Muse Code 1.4.14 (`muse exec --json`).
let tmpDir: string;
const cfg = () => ({ musePath: '/opt/bin/muse', envPassthrough: ['GH_TOKEN'] });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ev = (payload_type: string, payload: object) => ({ payload_type, payload: { kind: 'x', ...payload } });
const delta = (text: string) => ev('run.output.delta', { text });
const proposed = (task_kind: string) => ev('task.lifecycle.proposed', { event: { kind: 'proposed', task_kind } });
const toolResult = (tool_name: string, text: string, extra: object = {}) =>
  ev('tool.result', { text, correlation_facts: { tool_name, outcome: 'success' }, ...extra });
const done = (text: string) => ev('run.terminal.completed', { terminal: 'completed', text, reason: null });

let spawned: { cmd: string; args: string[]; prompt: string; env: Record<string, string> }[];
function queue(lines: object[], code = 0, signal: string | null = null) {
  const proc = Object.assign(new EventEmitter(), {
    stdout: Readable.from([lines.map(l => JSON.stringify(l)).join('\n') + '\n']),
    stderr: Readable.from([]), stdin: new PassThrough(), kill: vi.fn(),
  });
  vi.mocked(spawn).mockImplementationOnce(((cmd: string, args: string[], opts: { env: Record<string, string> }) => {
    const pf = args[args.indexOf('--prompt-file') + 1];
    spawned.push({ cmd, args, prompt: fs.readFileSync(pf, 'utf-8'), env: opts.env });
    setTimeout(() => proc.emit('close', code, signal), 20);
    return proc as any;
  }) as any);
}

describe('Muse provider', () => {
  let sm: SessionManager;
  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-'));
    sm = new SessionManager(cfg());
    spawned = [];
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('runs a turn on `muse exec`, with the system prompt in the prompt file', async () => {
    queue([delta('Looking.'), proposed('tool.bash'), toolResult('bash', JSON.stringify({ command: 'ls -la', exit_code: 0 })),
      delta('{"tldr":"ok"}'), done('{"tldr":"ok","decision":"x","rating":0}')]);
    const onMessage = vi.fn();
    const onToolUse = vi.fn();
    const r = await sm.query('bots', 'do it', { cwd: '/work/bots', systemPrompt: 'SYS', effort: 'high', onMessage, onToolUse });

    expect(spawned).toHaveLength(1);
    const { cmd, args, prompt } = spawned[0];
    expect(cmd).toBe('/opt/bin/muse');
    expect(args.slice(0, 4)).toEqual(['exec', '--json', '--yolo', '--trust-workspace']);
    expect(args).toContain('/work/bots');
    expect(args[args.indexOf('--reasoning-effort') + 1]).toBe('high');
    expect(args).not.toContain('--model');
    expect(prompt).toBe('SYS\n\n---\ndo it');
    expect(fs.existsSync(args[args.indexOf('--prompt-file') + 1])).toBe(false); // temp file cleaned up

    expect(r.text).toBe('{"tldr":"ok","decision":"x","rating":0}');
    expect(r.messages).toEqual(['Looking.', r.text]); // narration before the tool call, then the answer
    expect(onMessage.mock.calls.map(c => c[0])).toEqual(['Looking.', r.text]);
    expect(onToolUse).toHaveBeenCalledWith('Bash', 'ls -la', { parentId: null });
  });

  it('records token usage from run.usage', async () => {
    resetMuseUsage();
    queue([ev('run.usage', { calls: 2, allowance: null, models: [{ model: 'm', input_tokens: 100, cached_tokens: 40, output_tokens: 7, calls: 2 }] }), done('ok')]);
    await sm.query('bots', 'p', { cwd: '/w' });
    expect(getMuseUsage()).toMatchObject({ slug: 'bots', lastRun: { calls: 2, inputTokens: 100, cachedTokens: 40, outputTokens: 7 } });
  });

  it('keeps one session id per slug across turns', async () => {
    queue([done('a')]);
    queue([done('b')]);
    const first = await sm.query('bots', 'one', { cwd: '/w' });
    const second = await sm.query('bots', 'two', { cwd: '/w' });
    expect(first.sessionId).toMatch(UUID_RE);
    expect(second.sessionId).toBe(first.sessionId);
    expect(spawned.map(s => s.args[s.args.indexOf('--session-id') + 1])).toEqual([first.sessionId, first.sessionId]);
    expect(spawned[1].prompt).toBe('two');
  });

  it('resumes a loaded session id, and mints a new one after a reset', async () => {
    sm.loadSession('bots', '3a74a021-2d51-410e-a7d4-696aa1c3b716');
    queue([done('a')]);
    const r = await sm.query('bots', 'one', { cwd: '/w' });
    expect(r.sessionId).toBe('3a74a021-2d51-410e-a7d4-696aa1c3b716');
    sm.resetSession('bots');
    queue([done('b')]);
    const r2 = await sm.query('bots', 'two', { cwd: '/w' });
    expect(r2.sessionId).toMatch(UUID_RE);
    expect(r2.sessionId).not.toBe(r.sessionId);
  });

  it('strips secret-looking variables from the muse environment, keeping PATH/HOME and the passthrough list', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      MB_TEST_API_KEY: 'k', MB_TEST_TOKEN: 't', MB_TEST_SECRET: 's', BRIDGE_TOKEN: 'b', GH_TOKEN: 'gh',
      NODE_ENV: 'production', npm_config_prefix: '/x', MB_TEST_PLAIN: 'ok',
    });
    try {
      queue([done('a')]);
      await sm.query('bots', 'p', { cwd: '/w' });
      const env = spawned[0].env;
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.HOME).toBe(process.env.HOME);
      expect(env.MB_TEST_PLAIN).toBe('ok');
      expect(env.GH_TOKEN).toBe('gh'); // in envPassthrough
      for (const k of ['MB_TEST_API_KEY', 'MB_TEST_TOKEN', 'MB_TEST_SECRET', 'BRIDGE_TOKEN', 'NODE_ENV', 'npm_config_prefix']) {
        expect(env[k]).toBeUndefined();
      }
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it('cleanEnv matches secrets by suffix, not substring', () => {
    const env = cleanEnv({ KEYBOARD: '1', MONKEY: '1', SSH_AUTH_SOCK: '1', DB_PASSWORD: 'x', AWS_SECRET: 'x', TOKEN: 'x' });
    expect(Object.keys(env).sort()).toEqual(['KEYBOARD', 'MONKEY', 'SSH_AUTH_SOCK']);
  });

  it('reports file tools with absolute paths', async () => {
    queue([
      toolResult('write_file', 'wrote 3 bytes to /private/tmp/mp/b.txt; note: x', { edit_facts: { tool_name: 'write_file', path: 'b.txt' } }),
      toolResult('edit_file', 'edited', { edit_facts: { tool_name: 'edit_file', path: 'a.txt' } }),
      toolResult('read_file', 'Read text file `src/x.ts`.\n1|hi'),
      done('ok'),
    ]);
    const onToolUse = vi.fn();
    await sm.query('bots', 'p', { cwd: '/w', onToolUse });
    expect(onToolUse.mock.calls.map(c => [c[0], c[1]])).toEqual([
      ['Write', '/private/tmp/mp/b.txt'], ['Edit', '/w/a.txt'], ['Read', '/w/src/x.ts'],
    ]);
  });

  it('reports Muse subagents: Agent on spawn, summary + done on wait, abandoned if never reported', async () => {
    const spawn = (id: string, name: string) => toolResult('subagent_spawn', JSON.stringify({ status: 'accepted', subagent_id: id, agent_path: `main/${name}/1` }));
    queue([
      spawn('sa-1', 'counter'), spawn('sa-2', 'scout'),
      toolResult('subagent_wait', JSON.stringify({ status: 'ready', subagent_id: 'sa-1', summary: 'Line count: 3' })),
      toolResult('subagent_wait', JSON.stringify({ status: 'running', subagent_id: 'sa-2' })), // still going: ignored
      done('ok'),
    ]);
    const onToolUse = vi.fn();
    const onMessage = vi.fn();
    await sm.query('bots', 'p', { cwd: '/w', onToolUse, onMessage });
    const agentCalls = onToolUse.mock.calls.filter(c => c[0] === 'Agent');
    expect(agentCalls.map(c => [JSON.parse(c[1] || '{}').description, c[2].id, c[2].done, c[2].status])).toEqual([
      ['counter', 'sa-1', undefined, undefined],
      ['scout', 'sa-2', undefined, undefined],
      [undefined, 'sa-1', true, 'completed'],
      [undefined, 'sa-2', true, 'abandoned'],
    ]);
    expect(onMessage).toHaveBeenCalledWith('Line count: 3', { parentId: 'sa-1' });
    expect(onToolUse.mock.calls.some(c => c[0] === 'subagent_spawn')).toBe(false); // no stray tool line
  });

  it('renders todo snapshots as TodoWrite, images as Read/Write paths, and web/search tools', async () => {
    queue([
      ev('todo.snapshot.updated', { facts: { revision: 1, source_tool: 'write_todos', items: [{ text: 'A', status: 'completed' }, { text: 'B', status: 'in_progress' }] } }),
      toolResult('write_todos', '{"ok":true}'),
      toolResult('read_file', 'Read image file `shots/a.png` as model-visible image output.\nmedia_type: image/png'),
      toolResult('read_file', 'tool failed: No such file or directory (os error 2); requested absolute path "/w/HANDOFF.md"; resolved x'),
      toolResult('image_generation', 'Saved generated image to generated_images/x.png'),
      toolResult('web_search', JSON.stringify({ query: 'three.js InstancedMesh', results: [] })),
      toolResult('search', 'a.ts:1:foo\nb.ts:2:foo'),
      done('ok'),
    ]);
    const onToolUse = vi.fn();
    await sm.query('bots', 'p', { cwd: '/w', onToolUse });
    expect(onToolUse.mock.calls.map(c => [c[0], c[1]])).toEqual([
      ['TodoWrite', JSON.stringify({ todos: [{ content: 'A', status: 'completed', activeForm: 'A' }, { content: 'B', status: 'in_progress', activeForm: 'B' }] })],
      ['Read', '/w/shots/a.png'],
      ['Read', '/w/HANDOFF.md (failed)'],
      ['Write', '/w/generated_images/x.png'],
      ['WebSearch', 'three.js InstancedMesh'],
      ['Grep', '2 match lines'],
    ]);
  });

  it('maps noTools / disallowed tools to Muse switches', async () => {
    queue([done('a')]);
    await sm.query('bots', 'p', { cwd: '/w', noTools: true });
    expect(spawned[0].args).toEqual(expect.arrayContaining(['--disable-shell', '--disable-write', '--disable-web-tools']));
    queue([done('a')]);
    await sm.query('bots', 'p', { cwd: '/w', disallowedTools: ['Write', 'Edit'] });
    expect(spawned[1].args).toContain('--disable-write');
    expect(spawned[1].args).not.toContain('--disable-shell');
  });

  it('treats exit 143 as a kill, a failed run as an error, and no output as empty', async () => {
    queue([delta('half')], 143);
    await expect(sm.query('bots', 'p', { cwd: '/w' })).rejects.toThrow(/killed|terminated/i);
    queue([ev('run.terminal.failed', { terminal: 'failed', text: '', reason: 'auth expired' })], 1);
    await expect(sm.query('bots', 'p', { cwd: '/w' })).rejects.toThrow(/Muse run failed: auth expired/);
    queue([], 0);
    await expect(sm.query('bots', 'p', { cwd: '/w' })).rejects.toThrow(/empty response/);
  });
  it('oneShot runs read-only (no --yolo, no tools) in a fresh session and a throwaway workspace', async () => {
    queue([done('[{"slug":"a"}]')]);
    queue([done('second')]);
    expect(await sm.oneShot('rank these', { timeoutMs: 5000 })).toBe('[{"slug":"a"}]');
    expect(await sm.oneShot('again')).toBe('second');
    const { args, prompt } = spawned[0];
    expect(args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(args).not.toContain('--yolo');
    expect(args).not.toContain('--trust-workspace');
    expect(args).toEqual(expect.arrayContaining(['--disable-shell', '--disable-write', '--disable-web-tools']));
    expect(prompt).toBe('rank these');
    const ws = args[args.indexOf('--workspace') + 1];
    expect(ws).toContain('muse-bridge-oneshot-');
    expect(fs.existsSync(ws)).toBe(false);
    const ids = spawned.map(s => s.args[s.args.indexOf('--session-id') + 1]);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('oneShot rejects on timeout and stops the turn', async () => {
    const proc = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(),
      pid: undefined, exitCode: null, signalCode: null,
    });
    vi.mocked(spawn).mockImplementationOnce((() => proc) as any);
    const stop = vi.spyOn(sm, 'stop');
    await expect(sm.oneShot('slow', { timeoutMs: 30 })).rejects.toThrow(/timed out/);
    expect(stop).toHaveBeenCalledWith('(bridge)');
    proc.emit('close', 0, 'SIGTERM');
  });
});
