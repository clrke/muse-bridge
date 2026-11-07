import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { recordMuseRun } from './muse-usage.js';
import { museSubagentEvent, museTodoDetail, museToolLine } from './muse-events.js';

export interface SessionQueryOptions {
  cwd: string;
  /** Reply-format contract. `muse exec` has no system-prompt flag, so it is prepended to the prompt. */
  systemPrompt?: string;
  /** Tool families to switch off: `Bash` → --disable-shell, `Write`/`Edit`/`MultiEdit` → --disable-write. */
  disallowedTools?: string[];
  /** Run with no tools at all (shell, writes and web tools disabled). */
  noTools?: boolean;
  /**
   * Read-only turn: no `--yolo` (Muse's approval and sandbox stay on), no workspace rules and
   * no tools. For bridge-internal prompts that carry everything they need.
   */
  readOnly?: boolean;
  /** `muse exec --reasoning-effort` level. */
  effort?: string;
  /** `meta` is passed only for subagent text (`parentId` = the subagent's id). */
  onMessage?: (text: string, meta?: MessageMeta) => void;
  onToolUse?: (name: string, detail: string, meta?: ToolUseMeta) => void;
}

/** Attribution for assistant text a subagent emitted. */
export interface MessageMeta {
  parentId: string;
}

/**
 * Subagent attribution for a tool event. `parentId` pins a tool call to one subagent
 * (null = the main session). `done` marks the synthetic event fired when a subagent ends
 * (name `Agent`, empty detail, `id` = the subagent id).
 */
export interface ToolUseMeta {
  id?: string;
  parentId?: string | null;
  done?: boolean;
  /** With `done`: `completed`, `stopped`, `failed`, or `abandoned` when the process exited
   *  without ever reporting it. */
  status?: string;
}

export interface QueryResult {
  text: string;
  messages: string[]; // all assistant text messages in order
  toolsUsed: string[];
  sessionId: string;
}

interface SessionState {
  sessionId: string | undefined;
  forceNew: boolean;
  mutex: Promise<void>;
  process: ChildProcess | null;
  /** True while a turn for this slug holds the queue. */
  locked: boolean;
  lockedAt: number;
  /** Set by stop() so the kill is reported as a deliberate stop, not a crash. */
  stopRequested: boolean;
}

/** `muse exec --reasoning-effort` levels. */
const MUSE_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/**
 * Variables never handed to `muse` (agents run with every action pre-approved, so anything in
 * their environment is readable by whatever they execute): credentials by name, plus the
 * bridge's own runtime config. `NODE_ENV=production` would make npm skip devDependencies in
 * agent shells, and `npm_*` lifecycle vars (from `npm start`/`npx`) redirect global installs.
 */
const SECRET_ENV_RE = /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)$/i;

/** The environment for a spawned `muse`: `env` minus secrets and bridge runtime vars, except `passthrough`. */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env, passthrough: string[] = []): Record<string, string> {
  const keep = new Set(passthrough.map(k => k.toUpperCase()));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (!keep.has(k.toUpperCase())) {
      if (SECRET_ENV_RE.test(k)) continue;
      if (k === 'NODE_ENV' || /^npm_/i.test(k)) continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * One-line, prompt-free rendering of a `muse` invocation for display (the `cli_params` event
 * and logs): the prompt file path is hidden and the session id shortened to 8 chars.
 */
export function describeCliArgs(bin: string, args: string[], fresh = false): string {
  const out: string[] = [path.basename(bin)];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--prompt-file') { i++; out.push(a, '<prompt>'); continue; }
    if (a === '--session-id') { out.push(a, (args[++i] ?? '').slice(0, 8)); continue; }
    out.push(a);
  }
  if (fresh) out.push('(new session)');
  return out.join(' ');
}

/**
 * Collect a pid and all its descendants, deepest-last, by walking `pgrep -P`.
 * Used to stop a whole turn: `muse` may itself have spawned long-running grandchildren
 * (builds, test suites). Killing only the direct child leaves those orphaned and can keep the
 * inherited stdout pipe open, so the 'close' handler never fires and the turn never unblocks.
 *
 * NEVER kill by process group here: `muse` is spawned WITHOUT `detached`, so it shares the
 * bridge's own group and `kill(-pgid)` would take down the bridge.
 */
function collectDescendants(pid: number, depth = 0): number[] {
  if (depth > 10) return [];
  let children: number[] = [];
  try {
    children = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf-8' })
      .split('\n').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
  } catch {
    return []; // pgrep exits 1 when there are no children
  }
  return children.flatMap(c => [...collectDescendants(c, depth + 1), c]);
}

/** Best-effort signal to a pid and every descendant. Returns how many pids were signalled. */
function killTree(pid: number, signal: NodeJS.Signals): number {
  let n = 0;
  for (const p of [...collectDescendants(pid), pid]) {
    try {
      process.kill(p, signal);
      n++;
    } catch { /* already gone */ }
  }
  return n;
}

/** Session key of bridge-internal one-shot turns (not a valid project slug, so it can't clash). */
export const ONE_SHOT_KEY = '(bridge)';

/** Grace period between the SIGTERM and the SIGKILL escalation in stop(). */
const STOP_GRACE_MS = 5_000;

/** Message thrown when a turn was deliberately stopped; clients special-case this. */
export const STOPPED_BY_USER = 'Stopped by user 🛑';

export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private spawnListeners = new Map<string, Set<(line: string) => void>>();

  constructor(private config: Pick<Config, 'musePath' | 'envPassthrough'>) {}

  /** Subscribe to `muse` spawns for one slug (one summary line per spawn). Returns an unsubscribe fn. */
  onSpawn(slug: string, fn: (line: string) => void): () => void {
    let set = this.spawnListeners.get(slug);
    if (!set) this.spawnListeners.set(slug, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.spawnListeners.delete(slug);
    };
  }

  private emitSpawn(slug: string, args: string[], fresh: boolean): void {
    const line = describeCliArgs(this.config.musePath, args, fresh);
    console.log(`[SessionManager] ${slug}: spawn ${line}`);
    for (const fn of this.spawnListeners.get(slug) ?? []) {
      try { fn(line); } catch { /* a dead SSE stream must never break a spawn */ }
    }
  }

  loadSession(slug: string, sessionId: string): void {
    this.getOrCreate(slug).sessionId = sessionId;
    console.log(`[SessionManager] Loaded session for ${slug}: ${sessionId}`);
  }

  resetSession(slug: string): void {
    const state = this.getOrCreate(slug);
    state.forceNew = true;
    state.sessionId = undefined;
    console.log(`[SessionManager] Reset session for ${slug}`);
  }

  /**
   * Force-stop the in-flight turn for a slug.
   *
   * SIGTERMs `muse` and every descendant, then escalates to SIGKILL after a grace period.
   * The session id is kept on purpose: a stop ends the *turn*, not the conversation, so the
   * next message resumes with full context. Use /reset to discard the session.
   * Queued follow-ups are NOT cancelled.
   */
  stop(slug: string): { stopped: boolean; reason: string } {
    const state = this.sessions.get(slug);
    if (!state) return { stopped: false, reason: `No session for /${slug}` };
    const proc = state.process;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null || !proc.pid) {
      return { stopped: false, reason: `Nothing running for /${slug}` };
    }

    const pid = proc.pid;
    state.stopRequested = true;
    const n = killTree(pid, 'SIGTERM');
    const ranForMs = state.lockedAt ? Date.now() - state.lockedAt : 0;
    console.warn(`[SessionManager] ${slug}: STOP requested, SIGTERM to ${n} pid(s) (root ${pid}, running ${(ranForMs / 1000).toFixed(1)}s)`);

    setTimeout(() => {
      // Only escalate if this exact process is still the live one: a fast exit may already
      // have let the next queued turn spawn a different child.
      if (state.process === proc && proc.exitCode === null && proc.signalCode === null) {
        const k = killTree(pid, 'SIGKILL');
        console.warn(`[SessionManager] ${slug}: STOP escalated, SIGKILL to ${k} pid(s)`);
      }
    }, STOP_GRACE_MS).unref();

    return { stopped: true, reason: `Stopped /${slug} after ${(ranForMs / 1000).toFixed(0)}s (${n} process${n === 1 ? '' : 'es'})` };
  }

  /** True when a turn is currently running for this slug. */
  isRunning(slug: string): boolean {
    const proc = this.sessions.get(slug)?.process;
    return !!proc && proc.exitCode === null && proc.signalCode === null;
  }

  /** True when ANY project has a turn currently running. */
  anyRunning(): boolean {
    for (const slug of this.sessions.keys()) {
      if (this.isRunning(slug)) return true;
    }
    return false;
  }

  getSessionId(slug: string): string | undefined {
    return this.sessions.get(slug)?.sessionId;
  }

  async query(slug: string, prompt: string, opts: SessionQueryOptions): Promise<QueryResult> {
    const state = this.getOrCreate(slug);

    // Queue behind any in-flight query for this slug instead of killing it. `mutex` is a
    // chain of ALWAYS-settled promises so one failed query never wedges the queue.
    const run = state.mutex.then(async () => {
      state.locked = true;
      state.lockedAt = Date.now();
      try {
        return await this.runQuery(slug, state, prompt, opts);
      } finally {
        state.locked = false;
      }
    });
    state.mutex = run.then(() => undefined, () => undefined);
    return run;
  }

  private getOrCreate(slug: string): SessionState {
    let state = this.sessions.get(slug);
    if (!state) {
      state = { sessionId: undefined, forceNew: false, mutex: Promise.resolve(), process: null, locked: false, lockedAt: 0, stopRequested: false };
      this.sessions.set(slug, state);
    }
    return state;
  }

  private async runQuery(slug: string, state: SessionState, prompt: string, opts: SessionQueryOptions): Promise<QueryResult> {
    if (state.forceNew) {
      state.forceNew = false;
      state.sessionId = undefined;
      console.log(`[SessionManager] ${slug}: fresh conversation (reset requested)`);
    }
    const start = Date.now();
    // `muse exec --session-id <uuid>` creates the session on first use and continues it
    // afterwards, so one stable UUID per slug is all the resume state there is.
    const fresh = !state.sessionId;
    const sessionId = state.sessionId ?? randomUUID();
    state.sessionId = sessionId;
    console.log(`[SessionManager] ${slug}: calling muse (${fresh ? 'fresh' : 'resume'} session ${sessionId}, cwd: ${opts.cwd})`);

    try {
      const result = await this.spawnMuse(slug, state, prompt, opts, sessionId, fresh);
      console.log(`[SessionManager] ${slug}: done in ${((Date.now() - start) / 1000).toFixed(1)}s (${result.text.length} chars)`);
      return result;
    } catch (err) {
      if ((err as Error).message.includes('killed')) {
        // Either a deliberate stop() or something external killing the child.
        if (state.stopRequested) {
          state.stopRequested = false;
          console.log(`[SessionManager] ${slug}: turn stopped by user`);
          throw new Error(STOPPED_BY_USER);
        }
        throw new Error('Query aborted: process terminated unexpectedly');
      }
      console.error(`[SessionManager] ${slug}: failed after ${((Date.now() - start) / 1000).toFixed(1)}s: ${(err as Error).message}`);
      throw err;
    } finally {
      state.process = null;
      // Clear unconditionally: a stop() can land after the process already exited cleanly,
      // and a flag left set would mislabel the next failure as a user stop.
      state.stopRequested = false;
    }
  }

  /**
   * One Muse Code turn: `muse exec --json` streams JSONL events (run.output.delta text,
   * tool.result per tool call, run.usage, run.terminal.* with the final text). The
   * reply-format contract is prepended to the prompt each turn.
   */
  private spawnMuse(
    slug: string,
    state: SessionState,
    prompt: string,
    opts: SessionQueryOptions,
    sessionId: string,
    fresh: boolean,
  ): Promise<QueryResult> {
    return new Promise((resolve, reject) => {
      const fullPrompt = opts.systemPrompt ? `${opts.systemPrompt}\n\n---\n${prompt}` : prompt;
      const promptFile = path.join(os.tmpdir(), `muse-prompt-${randomUUID()}.txt`);
      fs.writeFileSync(promptFile, fullPrompt, { mode: 0o600 });
      const args = [
        'exec', '--json', ...(opts.readOnly ? [] : ['--yolo', '--trust-workspace']),
        '--workspace', opts.cwd, '--session-id', sessionId, '--prompt-file', promptFile,
      ];
      if (opts.effort && MUSE_EFFORTS.has(opts.effort)) args.push('--reasoning-effort', opts.effort);
      const denied = new Set(opts.disallowedTools ?? []);
      const noTools = opts.noTools || opts.readOnly;
      if (noTools || denied.has('Bash')) args.push('--disable-shell');
      if (noTools || ['Write', 'Edit', 'MultiEdit'].some(t => denied.has(t))) args.push('--disable-write');
      if (noTools) args.push('--disable-web-tools');
      this.emitSpawn(slug, args, fresh);

      const cleanup = () => { try { fs.unlinkSync(promptFile); } catch { /* already gone */ } };
      let proc: ChildProcess;
      try {
        proc = spawn(this.config.musePath, args, {
          cwd: opts.cwd,
          env: cleanEnv(process.env, this.config.envPassthrough),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }
      state.process = proc;

      const toolsUsed: string[] = [];
      const messages: string[] = [];
      let pendingText = '';
      let finalText = '';
      // Muse subagents (subagent_spawn, then subagent_wait/read_result/cancel).
      const openAgents = new Set<string>();
      const agentEnded = (id: string, status: string) => {
        if (!openAgents.delete(id)) return;
        opts.onToolUse?.('Agent', '', { id, done: true, status });
      };
      let terminal: { terminal?: string; reason?: string | null } | null = null;

      // Narration the model streams before a tool call goes out as its own message.
      const flushNarration = () => {
        const t = pendingText.trim();
        pendingText = '';
        if (t) { messages.push(t); opts.onMessage?.(t); }
      };

      proc.on('error', (err) => { cleanup(); reject(err); });

      const rl = createInterface({ input: proc.stdout! });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          const m = JSON.parse(line);
          const type: string = m.payload_type ?? '';
          const p = m.payload ?? {};
          if (type === 'run.output.delta') {
            pendingText += typeof p.text === 'string' ? p.text : '';
          } else if (type === 'task.lifecycle.proposed' && typeof p.event?.task_kind === 'string' && p.event.task_kind.startsWith('tool.')) {
            flushNarration();
          } else if (type === 'tool.result') {
            const tool: string = p.correlation_facts?.tool_name ?? 'tool';
            const text: string = typeof p.text === 'string' ? p.text : '';
            const sub = museSubagentEvent(tool, text);
            if (sub?.kind === 'spawned') {
              // The spawn arguments aren't in the stream: the agent's name is all there is.
              openAgents.add(sub.id);
              toolsUsed.push('Agent');
              opts.onToolUse?.('Agent', JSON.stringify({ description: sub.name, subagent_type: 'muse', prompt: '' }), { id: sub.id, parentId: null });
            } else if (sub?.kind === 'ended') {
              if (openAgents.has(sub.id) && sub.summary) opts.onMessage?.(sub.summary, { parentId: sub.id });
              agentEnded(sub.id, sub.status ?? 'completed');
            } else {
              const tl = museToolLine(tool, text, p.edit_facts?.path, opts.cwd);
              if (tl) {
                toolsUsed.push(tl.name);
                opts.onToolUse?.(tl.name, tl.detail.slice(0, 1500), { parentId: null });
              }
            }
          } else if (type === 'todo.snapshot.updated') {
            const detail = museTodoDetail(p.facts);
            if (detail) opts.onToolUse?.('TodoWrite', detail, { parentId: null });
          } else if (type === 'run.usage') {
            const u = Array.isArray(p.models) ? p.models[0] : undefined;
            recordMuseRun(slug, p);
            console.log(`[SessionManager] ${slug}: muse usage calls=${p.calls ?? '?'} in=${u?.input_tokens ?? '?'} cached=${u?.cached_tokens ?? '?'} out=${u?.output_tokens ?? '?'} model=${u?.model ?? '?'}`);
          } else if (type.startsWith('run.terminal.')) {
            terminal = p;
            if (typeof p.text === 'string') finalText = p.text;
          }
        } catch { /* skip unparseable lines */ }
      });

      let stderr = '';
      proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });

      proc.on('close', (code, signal) => {
        cleanup();
        const killedRun = signal === 'SIGTERM' || signal === 'SIGKILL' || code === 143 || code === 137;
        // Agents Muse never reported finished end with the process.
        for (const id of [...openAgents]) agentEnded(id, killedRun ? 'stopped' : 'abandoned');
        if (killedRun) return reject(new Error('Process killed'));
        const text = (finalText || pendingText).trim();
        if (terminal && terminal.terminal !== 'completed' && !text) {
          return reject(new Error(`Muse run ${terminal.terminal ?? 'ended'}${terminal.reason ? `: ${terminal.reason}` : ''}`));
        }
        if (code !== 0 && !text) {
          return reject(new Error(`Muse CLI exited with code ${code}: ${stderr.slice(-500)}`));
        }
        if (!text) {
          return reject(new Error(`Muse CLI returned empty response${stderr ? ': ' + stderr.slice(-200) : ''}`));
        }
        messages.push(text);
        opts.onMessage?.(text);
        resolve({ text, messages, toolsUsed, sessionId });
      });
    });
  }

  /**
   * One read-only Muse turn outside any project (see `readOnly`), in a fresh session and an
   * empty temporary workspace. Rejects on failure, or after `timeoutMs` (the turn is stopped).
   */
  async oneShot(prompt: string, opts: { key?: string; timeoutMs?: number; effort?: string } = {}): Promise<string> {
    const key = opts.key ?? ONE_SHOT_KEY;
    const timeoutMs = opts.timeoutMs ?? 90_000;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-bridge-oneshot-'));
    this.resetSession(key);
    let timer: NodeJS.Timeout | undefined;
    try {
      const turn = this.query(key, prompt, { cwd, readOnly: true, effort: opts.effort });
      turn.catch(() => { /* a timed-out turn rejects later, unobserved */ });
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          this.stop(key);
          reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      });
      return (await Promise.race([turn, timeout])).text;
    } finally {
      clearTimeout(timer);
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }

  async waitForIdle(maxMs: number = 60_000, pollMs: number = 200): Promise<boolean> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      let anyLocked = false;
      for (const state of this.sessions.values()) {
        if (state.locked) { anyLocked = true; break; }
      }
      if (!anyLocked) return true;
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    return false;
  }
}
