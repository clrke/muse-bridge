/**
 * Serve-backed sessions: the same public surface as SessionManager, but each
 * project holds one persistent `muse serve` host (see msp-client.ts) instead of
 * one-shot `muse exec` children. Turns stream the host's view events through
 * the same onMessage/onToolUse contract, plus onApproval per resolved approval.
 *
 * Deliberate divergences from the exec driver, all from the 2026-11-08 spike:
 *  - stop() is turn/interrupt first, SIGTERM/SIGKILL of the host after the same
 *    grace; there is no pgrep descendant walk (turn completion keys off the
 *    host's stdout, not grandchildren pipes — the host owns its children).
 *  - tool restriction is fail-closed: readOnly/noTools/disallowedTools select
 *    the denyUnmatched approval mode, since per-tool flags are host-fixed.
 *  - judge escalations (approval/request) are denied with a warning: v1 has no
 *    UI round-trip, and a pended turn with zero visibility is worse than a
 *    denied tool call. decideApproval() is the future UI path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordMuseRun } from './muse-usage.js';
import { MspClient, MspError, type MspApprovalMode, type MspEvent } from './msp-client.js';
import {
  mspAgentText,
  mspApprovalSummary,
  mspSubagentLine,
  mspTextDelta,
  mspTodoDetail,
  mspToolLine,
  mspTurnTerminal,
} from './msp-events.js';
import {
  MUSE_EFFORTS,
  ONE_SHOT_KEY,
  STOPPED_BY_USER,
  SessionManager,
  type QueryResult,
  type SessionDriver,
  type SessionQueryOptions,
} from './session-manager.js';
import type { Config, SessionDriverKind } from './config.js';

const STOP_GRACE_MS = 5_000;

interface TurnCollectors {
  opts: SessionQueryOptions;
  cwd: string;
  toolsUsed: string[];
  openAgents: Set<string>;
  reviewing: Map<string, any>;
  agentEnded: (id: string, status: string) => void;
  flushNarration: () => void;
  appendText: (t: string) => void;
  setFinal: (t: string) => void;
  finish: (terminal: string, reason?: string) => void;
}

interface ServeState {
  sessionId: string | undefined;
  /** A replaced id the host still holds; left (unloaded) on the next turn. */
  pendingLeave?: string;
  /** The host the session id is loaded on; resume is skipped when it matches. */
  loadedOn?: MspClient;
  forceNew: boolean;
  mutex: Promise<void>;
  client: MspClient | null;
  turnId: string | null;
  locked: boolean;
  lockedAt: number;
  stopRequested: boolean;
  /** Live only while a turn collects view events (same lifetime as the waiter). */
  collectors?: TurnCollectors;
}

interface TurnWaiter {
  resolve: (v: QueryResult) => void;
  reject: (e: Error) => void;
}

/** Build the configured driver. Exported for tests; server.ts is the only caller. */
export function createSessionDriver(
  driver: SessionDriverKind,
  config: Pick<Config, 'musePath' | 'envPassthrough'>,
): SessionDriver {
  return driver === 'serve' ? new ServeSessionManager(config) : new SessionManager(config);
}

const canonical = (cwd: string): string => {
  try {
    return fs.realpathSync(cwd);
  } catch {
    return cwd; // session/start validates; a missing dir fails loudly there
  }
};

export class ServeSessionManager implements SessionDriver {
  private sessions = new Map<string, ServeState>();
  private spawnListeners = new Map<string, Set<(line: string) => void>>();

  constructor(private config: Pick<Config, 'musePath' | 'envPassthrough'>) {}

  /** Subscribe to serve-host/session lines for one slug (the `cli_params` event). */
  onSpawn(slug: string, fn: (line: string) => void): () => void {
    let set = this.spawnListeners.get(slug);
    if (!set) this.spawnListeners.set(slug, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.spawnListeners.delete(slug);
    };
  }

  private emitSpawn(slug: string, line: string): void {
    console.log(`[ServeSessions] ${slug}: ${line}`);
    for (const fn of this.spawnListeners.get(slug) ?? []) {
      try {
        fn(line);
      } catch {
        /* a dead SSE stream must never break a spawn */
      }
    }
  }

  loadSession(slug: string, sessionId: string): void {
    this.getOrCreate(slug).sessionId = sessionId;
    console.log(`[ServeSessions] Loaded session for ${slug}: ${sessionId}`);
  }

  resetSession(slug: string): void {
    const state = this.getOrCreate(slug);
    state.forceNew = true;
    // The id is dropped now (exec parity for getSessionId) but the server
    // session is still left on the next turn via pendingLeave.
    state.pendingLeave = state.sessionId ?? state.pendingLeave;
    state.sessionId = undefined;
    state.loadedOn = undefined;
    console.log(`[ServeSessions] Reset session for ${slug}`);
  }

  /**
   * Force-stop the in-flight turn for a slug: turn/interrupt now, host kill
   * after the grace. Keeps the session id — a stop ends the turn, not the
   * conversation. Queued follow-ups are NOT cancelled.
   */
  stop(slug: string): { stopped: boolean; reason: string } {
    const state = this.sessions.get(slug);
    if (!state || !state.turnId || !state.client || state.client.closed) {
      return { stopped: false, reason: state ? `Nothing running for /${slug}` : `No session for /${slug}` };
    }
    const turnId = state.turnId;
    const client = state.client;
    state.stopRequested = true;
    const ranForMs = state.lockedAt ? Date.now() - state.lockedAt : 0;
    console.warn(`[ServeSessions] ${slug}: STOP requested, turn/interrupt (running ${(ranForMs / 1000).toFixed(1)}s)`);
    client.interrupt(state.sessionId!, turnId).catch(() => {
      /* the turn may already be over; the grace kill below still applies */
    });
    setTimeout(() => {
      // Only escalate if this exact turn is still in flight.
      if (state.turnId === turnId && state.client === client && !client.closed) {
        console.warn(`[ServeSessions] ${slug}: STOP escalated, closing serve host`);
        void client.close();
      }
    }, STOP_GRACE_MS).unref();

    return { stopped: true, reason: `Stopped /${slug} after ${(ranForMs / 1000).toFixed(0)}s` };
  }

  /** True when a turn is currently running for this slug. */
  isRunning(slug: string): boolean {
    const state = this.sessions.get(slug);
    return !!state && state.turnId !== null && !!state.client && !state.client.closed;
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

  /** Decide a judge escalation (future UI path; v1 auto-denies, see runTurn). */
  async decideApproval(args: {
    slug: string;
    approvalId: string;
    choiceId: string;
    requirementId: unknown;
    feedback?: string;
  }): Promise<unknown> {
    const state = this.sessions.get(args.slug);
    if (!state?.client || state.client.closed || !state.sessionId) {
      throw new Error(`No live serve session for /${args.slug}`);
    }
    return state.client.decideApproval({ sessionId: state.sessionId, ...args });
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
    state.mutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private getOrCreate(slug: string): ServeState {
    let state = this.sessions.get(slug);
    if (!state) {
      state = {
        sessionId: undefined, forceNew: false, mutex: Promise.resolve(),
        client: null, turnId: null, locked: false, lockedAt: 0, stopRequested: false,
      };
      this.sessions.set(slug, state);
    }
    return state;
  }

  private async runQuery(slug: string, state: ServeState, prompt: string, opts: SessionQueryOptions): Promise<QueryResult> {
    if (state.forceNew) {
      state.forceNew = false;
      const stale = state.pendingLeave ?? state.sessionId;
      state.pendingLeave = undefined;
      state.sessionId = undefined;
      state.loadedOn = undefined;
      if (stale && state.client && !state.client.closed) {
        await state.client.leave(stale).catch(() => {
          /* best effort; the host may already be gone */
        });
      }
      console.log(`[ServeSessions] ${slug}: fresh conversation (reset requested)`);
    }
    const start = Date.now();
    const mode: MspApprovalMode =
      opts.readOnly || opts.noTools || (opts.disallowedTools?.length ?? 0) > 0 ? 'denyUnmatched' : 'promptUnmatched';
    const cwd = canonical(opts.cwd);
    const fresh = !state.sessionId;

    try {
      const client = await this.ensureClient(slug, state);
      const sessionId = await this.ensureSession(slug, state, client, cwd, mode);
      console.log(`[ServeSessions] ${slug}: turn on serve (${fresh ? 'fresh' : 'resume'} session ${sessionId}, cwd: ${cwd})`);
      const result = await this.runTurn(slug, state, client, sessionId, prompt, opts, cwd);
      console.log(`[ServeSessions] ${slug}: done in ${((Date.now() - start) / 1000).toFixed(1)}s (${result.text.length} chars)`);
      return result;
    } catch (err) {
      if (state.stopRequested) {
        state.stopRequested = false;
        console.log(`[ServeSessions] ${slug}: turn stopped by user`);
        throw new Error(STOPPED_BY_USER);
      }
      console.error(`[ServeSessions] ${slug}: failed after ${((Date.now() - start) / 1000).toFixed(1)}s: ${(err as Error).message}`);
      throw err;
    } finally {
      state.turnId = null;
      // Clear unconditionally: a stop() can land after the turn already finished,
      // and a flag left set would mislabel the next failure as a user stop.
      state.stopRequested = false;
    }
  }

  private async ensureClient(slug: string, state: ServeState): Promise<MspClient> {
    if (state.client && !state.client.closed) return state.client;
    const client = new MspClient({ musePath: this.config.musePath, envPassthrough: this.config.envPassthrough });
    client.onEvent((e) => this.dispatch(slug, state, e));
    client.onClose(() => this.failTurn(state, new MspError('serve', -32000, 'serve host exited mid-turn')));
    await client.start();
    state.client = client;
    this.emitSpawn(slug, 'muse serve (new host)');
    return client;
  }

  private async ensureSession(
    slug: string, state: ServeState, client: MspClient, cwd: string, mode: MspApprovalMode,
  ): Promise<string> {
    // Already loaded on this host (the common case: one session per project).
    // The mode is re-applied every turn — a readOnly turn on a promptUnmatched
    // session must still deny tools — and is a cheap idempotent round trip.
    if (state.sessionId && state.loadedOn === client) {
      await client.setApprovalMode(state.sessionId, mode).catch(() => {
        /* the turn still runs under the stored mode */
      });
      return state.sessionId;
    }
    if (state.sessionId) {
      try {
        const r = await client.resumeSession(state.sessionId);
        const id = r?.session?.sessionId;
        if (typeof id === 'string' && id) {
          state.sessionId = id;
          state.loadedOn = client;
          this.emitSpawn(slug, `muse serve (resume session ${id.slice(0, 8)}, ${mode})`);
          await client.setApprovalMode(id, mode).catch(() => {
            /* durable sessions keep their stored mode; the turn still runs */
          });
          return id;
        }
      } catch (err) {
        console.warn(`[ServeSessions] ${slug}: resume failed (${(err as Error).message}), starting fresh`);
      }
    }
    const r = await client.startSession(cwd, mode);
    const id = r?.session?.sessionId;
    if (typeof id !== 'string' || !id) throw new MspError('session/start', -32000, 'host returned no session id');
    state.sessionId = id;
    state.loadedOn = client;
    this.emitSpawn(slug, `muse serve (new session ${id.slice(0, 8)}, ${mode})`);
    return id;
  }

  private async leaveQuietly(state: ServeState): Promise<void> {
    if (state.client && !state.client.closed && state.sessionId) {
      await state.client.leave(state.sessionId).catch(() => {
        /* best effort; the host may already be gone */
      });
    }
  }

  private turnWaiters = new Map<ServeState, TurnWaiter>();

  private runTurn(
    slug: string, state: ServeState, client: MspClient, sessionId: string,
    prompt: string, opts: SessionQueryOptions, cwd: string,
  ): Promise<QueryResult> {
    return new Promise<QueryResult>((resolve, reject) => {
      const fullPrompt = opts.systemPrompt ? `${opts.systemPrompt}\n\n---\n${prompt}` : prompt;
      const toolsUsed: string[] = [];
      const messages: string[] = [];
      let pendingText = '';
      let finalText = '';
      const openAgents = new Set<string>();
      const reviewing = new Map<string, any>();
      const agentEnded = (id: string, status: string) => {
        if (!openAgents.delete(id)) return;
        opts.onToolUse?.('Agent', '', { id, done: true, status });
      };
      const flushNarration = () => {
        const t = pendingText.trim();
        pendingText = '';
        if (t) {
          messages.push(t);
          opts.onMessage?.(t);
        }
      };
      const waiter: TurnWaiter = { resolve, reject };
      // Stash the collectors where dispatch() reaches them.
      state.collectors = {
        opts, cwd, toolsUsed, openAgents, reviewing, agentEnded, flushNarration,
        appendText: (t: string) => {
          pendingText += t;
        },
        setFinal: (t: string) => {
          finalText = t;
        },
        finish: (terminal: string, reason?: string) => {
          for (const id of [...openAgents]) agentEnded(id, terminal === 'cancelled' ? 'stopped' : 'abandoned');
          if (terminal === 'cancelled') {
            reject(new Error('Turn cancelled'));
            return;
          }
          const text = (finalText || pendingText).trim();
          if (terminal !== 'completed' && !text) {
            reject(new Error(`Muse turn ${terminal}${reason ? `: ${reason}` : ''}`));
            return;
          }
          if (!text) {
            reject(new Error('Muse CLI returned empty response'));
            return;
          }
          messages.push(text);
          opts.onMessage?.(text);
          resolve({ text, messages, toolsUsed, sessionId });
        },
      };
      this.turnWaiters.set(state, waiter);

      const start = client.startTurn(sessionId, fullPrompt, {
        displayText: prompt,
        ...(opts.effort && MUSE_EFFORTS.has(opts.effort) ? { reasoningEffort: opts.effort } : {}),
        workspaceRoot: cwd,
      });
      start.then(
        (ack) => {
          const turnId = typeof ack?.turnId === 'string' ? ack.turnId : null;
          if (!turnId) {
            this.turnWaiters.delete(state);
            state.collectors = undefined;
            reject(new MspError('turn/start', -32000, 'host returned no turn id'));
            return;
          }
          state.turnId = turnId;
        },
        (err) => {
          this.turnWaiters.delete(state);
          state.collectors = undefined;
          reject(err);
        },
      );
    });
  }

  private failTurn(state: ServeState, err: Error): void {
    const w = this.turnWaiters.get(state);
    if (!w) return;
    this.turnWaiters.delete(state);
    state.turnId = null;
    state.collectors = undefined;
    w.reject(err);
  }

  /** One view event from any slug's host, folded into the in-flight turn. */
  private dispatch(slug: string, state: ServeState, e: MspEvent): void {
    // No turn is collecting (between turns, or a stale event): nothing resolves.
    const c = state.collectors;
    if (!c || !this.turnWaiters.has(state)) return;
    const opts = c.opts;
    const p = e.params ?? {};

    switch (e.method) {
      case 'item/delta': {
        const t = mspTextDelta(p);
        if (t) c.appendText(t);
        return;
      }
      case 'item/started': {
        if (p?.item?.kind === 'toolCall') c.flushNarration();
        if (p?.item?.kind === 'subagent' && typeof p.item.itemId === 'string') {
          const id = p.item.itemId as string;
          const name = typeof p.item.name === 'string' ? p.item.name : typeof p.item.title === 'string' ? p.item.title : 'subagent';
          if (!c.openAgents.has(id)) {
            c.openAgents.add(id);
            c.toolsUsed.push('Agent');
            opts.onToolUse?.('Agent', JSON.stringify({ description: name, subagent_type: 'muse', prompt: '' }), {
              id, parentId: null,
            });
          }
        }
        return;
      }
      case 'item/completed': {
        const item = p?.item;
        if (!item) return;
        if (item.kind === 'toolCall') {
          const tl = mspToolLine(item, c.cwd);
          if (tl) {
            c.toolsUsed.push(tl.name);
            opts.onToolUse?.(tl.name, tl.detail.slice(0, 1500), { parentId: null });
          }
          return;
        }
        const text = mspAgentText(item);
        if (text !== null) {
          c.setFinal(text);
          return;
        }
        const sub = mspSubagentLine(item);
        if (sub) {
          const id = typeof item.itemId === 'string' ? item.itemId : '';
          const status = sub.status === 'cancelled' ? 'stopped' : sub.status;
          if (sub.status === 'running' || sub.status === 'inprogress') return; // not terminal yet
          if (id && c.openAgents.has(id) && sub.summary) opts.onMessage?.(sub.summary, { parentId: id });
          if (id) c.agentEnded(id, status);
          return;
        }
        return;
      }
      case 'session/todoListChanged': {
        const detail = mspTodoDetail(p?.items);
        if (detail) opts.onToolUse?.('TodoWrite', detail, { parentId: null });
        return;
      }
      case 'session/tokenUsage': {
        const u = p?.usage ?? {};
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
        recordMuseRun(slug, {
          calls: 1,
          models: [
            {
              model: p?.modelId ?? '?',
              input_tokens: num(u.inputTokens) ?? 0,
              cached_tokens: num(u.cachedTokens) ?? 0,
              output_tokens: num(u.outputTokens) ?? 0,
            },
          ],
        });
        console.log(
          `[ServeSessions] ${slug}: muse usage calls=1 in=${num(u.inputTokens) ?? '?'} cached=${num(u.cachedTokens) ?? '?'} out=${num(u.outputTokens) ?? '?'} model=${p?.modelId ?? '?'}`,
        );
        return;
      }
      case 'approval/reviewing': {
        if (typeof p?.approvalId === 'string') c.reviewing.set(p.approvalId, p);
        return;
      }
      case 'approval/resolved': {
        if (typeof p?.approvalId === 'string') {
          const s = mspApprovalSummary(p, c.reviewing.get(p.approvalId));
          c.reviewing.delete(p.approvalId);
          if (s) opts.onApproval?.(s);
        }
        return;
      }
      case 'approval/request':
      case 'approval/requested': {
        // Judge escalation with no UI round-trip in v1: deny fail-closed so the
        // turn degrades instead of hanging with zero visibility.
        if (typeof p?.approvalId !== 'string') return;
        console.warn(`[ServeSessions] ${slug}: judge escalation for ${p.approvalId}, auto-denying (no decider wired)`);
        const choices: any[] = Array.isArray(p?.availableChoices) ? p.availableChoices : [];
        const ids = choices.map((ch) => ch?.choiceId).filter((id): id is string => typeof id === 'string');
        const pick = ids.find((id) => /reject|deny|never/i.test(id)) ?? ids[ids.length - 1];
        if (pick && state.client && state.sessionId) {
          void state.client
            .decideApproval({ sessionId: state.sessionId, approvalId: p.approvalId, choiceId: pick, requirementId: p.currentRequirementId })
            .catch((err) => console.warn(`[ServeSessions] ${slug}: auto-deny failed: ${(err as Error).message}`));
        }
        if (e.id !== undefined) state.client?.respond(e.id, {});
        return;
      }
      case 'turn/completed': {
        // The ack carrying our turnId resolves a microtask after its line, so a
        // same-tick completion can arrive first: only filter when we know ours.
        if (state.turnId !== null && p.turnId !== state.turnId) return; // stale turn
        this.turnWaiters.delete(state);
        state.turnId = null;
        state.collectors = undefined;
        c.finish(mspTurnTerminal(p), typeof p?.reason === 'string' ? p.reason : undefined);
        return;
      }
      default:
        return; // status changes, usage context, mode changes: nothing to fold
    }
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
      turn.catch(() => {
        /* a timed-out turn rejects later, unobserved */
      });
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

  async waitForIdle(maxMs = 60_000, pollMs = 200): Promise<boolean> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      let anyLocked = false;
      for (const state of this.sessions.values()) {
        if (state.locked) {
          anyLocked = true;
          break;
        }
      }
      if (!anyLocked) return true;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return false;
  }

  /** Leave every session and close every host. For shutdown, after waitForIdle. */
  async closeAll(): Promise<void> {
    for (const state of this.sessions.values()) {
      await this.leaveQuietly(state);
      const client = state.client;
      state.client = null;
      state.turnId = null;
      if (client && !client.closed) await client.close().catch(() => {});
    }
  }
}
