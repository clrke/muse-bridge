/**
 * JSON-RPC client for Muse's MSP server (`muse serve` over stdio).
 *
 * Wire facts, verified live against Muse Code 1.4.14 (spike 2026-11-08):
 *  - framing is JSONL: one object per line, both directions;
 *  - handshake is `initialize` (request) then `initialized` (notification);
 *    anything earlier is refused `notInitialized`;
 *  - every command takes an idempotency `commandId` (UUIDv7), minted here;
 *  - `session/start` demands canonical `workspaceRoots` (/tmp must be /private/tmp);
 *  - responses route by numeric `id`; anything with a `method` is a view event.
 *
 * The client owns one `serve` process (single-client stdio host) and speaks for
 * exactly one bridge project. It never interprets view items — it routes them to
 * listeners (see msp-events.ts). Durable sessions (resume across restarts) are the
 * default: no `--no-session-log`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { cleanEnv } from './session-manager.js';

/** Approval enforcement modes the host admits on the wire (stable surface). */
export type MspApprovalMode = 'allowAll' | 'promptUnmatched' | 'onRequest' | 'denyUnmatched';

/** A server-to-client message: view event, approval event, or (rarely) request. */
export interface MspEvent {
  method: string;
  params: any;
  /** Present when the server expects a reply; answer with respond(). */
  id?: number;
}

/** A rejected request, or a dead transport. `kind`/`reason` come from error.data. */
export class MspError extends Error {
  code: number;
  kind?: string;
  reason?: string;
  retryable?: boolean;
  constructor(method: string, code: number, message: string, data?: any) {
    super(`${method}: ${message}`);
    this.name = 'MspError';
    this.code = code;
    this.kind = typeof data?.kind === 'string' ? data.kind : undefined;
    this.reason = typeof data?.reason === 'string' ? data.reason : undefined;
    this.retryable = typeof data?.retryable === 'boolean' ? data.retryable : undefined;
  }
}

/** Time-ordered, server-required idempotency handle for every command. */
export function uuidv7(): string {
  const b = randomBytes(16);
  const t = BigInt(Date.now());
  b[0] = Number((t >> 40n) & 0xffn);
  b[1] = Number((t >> 32n) & 0xffn);
  b[2] = Number((t >> 24n) & 0xffn);
  b[3] = Number((t >> 16n) & 0xffn);
  b[4] = Number((t >> 8n) & 0xffn);
  b[5] = Number(t & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface MspClientOptions {
  musePath: string;
  envPassthrough?: string[];
  /** Per-request timeout; the turn lifecycle itself arrives as events. */
  requestTimeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
}

interface Pending {
  method: string;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class MspClient {
  private proc: ChildProcess | null = null;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private events = new Set<(e: MspEvent) => void>();
  private closers = new Set<(info: { code: number | null; signal: string | null }) => void>();
  private stderrTail = '';
  private readonly timeoutMs: number;
  private readonly name: string;
  private readonly version: string;

  constructor(private opts: MspClientOptions) {
    this.timeoutMs = opts.requestTimeoutMs ?? 15000;
    // The host requires ^[a-z0-9_]+$ (SS1.4.1): no hyphens. Found by the first
    // live E2E turn — the spike probes used 'spike' and never tripped this.
    this.name = opts.clientName ?? 'muse_bridge';
    this.version = opts.clientVersion ?? '0.1.0';
  }

  get closed(): boolean {
    return this.proc === null;
  }

  /** Every server-to-client message with a `method` (view + approval events). */
  onEvent(fn: (e: MspEvent) => void): () => void {
    this.events.add(fn);
    return () => {
      this.events.delete(fn);
    };
  }

  onClose(fn: (info: { code: number | null; signal: string | null }) => void): () => void {
    this.closers.add(fn);
    return () => {
      this.closers.delete(fn);
    };
  }

  /** Spawn the host and complete the initialize handshake. */
  async start(): Promise<void> {
    if (this.proc) return;
    const proc = spawn(this.opts.musePath, ['serve', '--trust-workspace'], {
      cwd: os.homedir(),
      env: cleanEnv(process.env, this.opts.envPassthrough ?? []),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    proc.on('error', (err) => this.failAll(`serve spawn failed: ${(err as Error).message}`));
    proc.stderr?.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString('utf-8')).slice(-2048);
    });
    const rl = createInterface({ input: proc.stdout! });
    rl.on('line', (line) => this.onLine(line));
    proc.on('close', (code, signal) => {
      this.proc = null;
      this.failAll(`serve exited (code ${code}, signal ${signal})${this.stderrTail ? `: ${this.stderrTail.slice(-300)}` : ''}`);
      for (const fn of this.closers) {
        try {
          fn({ code, signal });
        } catch {
          /* listener bugs must never break teardown */
        }
      }
    });
    const init = await this.request('initialize', {
      clientInfo: { name: this.name, version: this.version },
    });
    if (init?.experimentalApi) throw new MspError('initialize', -32600, 'host demands experimentalApi');
    this.notify('initialized', {});
  }

  /** One request; resolves with `result`, rejects with MspError. */
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<any> {
    const proc = this.proc;
    if (!proc?.stdin) return Promise.reject(new MspError(method, -32000, 'serve process is closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MspError(method, -32000, `request timed out after ${timeoutMs ?? this.timeoutMs}ms`));
      }, timeoutMs ?? this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  /** A notification (no reply): `initialized`, and acks the driver composes itself. */
  notify(method: string, params: Record<string, unknown>): void {
    this.proc?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  /** Answer a server-to-client request (an MspEvent carrying `id`). */
  respond(id: number, result: unknown): void {
    this.proc?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  async startSession(workspaceRoot: string, approvalMode: MspApprovalMode): Promise<any> {
    return this.request('session/start', { commandId: uuidv7(), approvalMode, workspaceRoots: [workspaceRoot] });
  }

  async resumeSession(sessionId: string): Promise<any> {
    return this.request('session/resume', { commandId: uuidv7(), sessionId, excludeItems: true });
  }

  async setApprovalMode(sessionId: string, mode: MspApprovalMode): Promise<any> {
    return this.request('session/setApprovalMode', { commandId: uuidv7(), sessionId, mode });
  }

  async startTurn(
    sessionId: string,
    text: string,
    opts: { displayText?: string; reasoningEffort?: string; workspaceRoot?: string } = {},
  ): Promise<any> {
    const params: Record<string, unknown> = {
      commandId: uuidv7(),
      sessionId,
      input: [{ type: 'text', text }],
    };
    if (opts.displayText !== undefined) params.displayText = opts.displayText;
    if (opts.reasoningEffort !== undefined) params.reasoningEffort = opts.reasoningEffort;
    // Sticky: binds at this turn's launch and persists until replaced again.
    if (opts.workspaceRoot !== undefined) params.workspaceRoots = [opts.workspaceRoot];
    return this.request('turn/start', params);
  }

  async interrupt(sessionId: string, turnId?: string): Promise<any> {
    const params: Record<string, unknown> = { commandId: uuidv7(), sessionId };
    if (turnId !== undefined) params.turnId = turnId;
    return this.request('turn/interrupt', params);
  }

  async listPending(sessionId: string): Promise<any> {
    return this.request('approval/listPending', { sessionId });
  }

  async decideApproval(args: {
    sessionId: string;
    approvalId: string;
    choiceId: string;
    requirementId: unknown;
    feedback?: string;
  }): Promise<any> {
    const params: Record<string, unknown> = {
      commandId: uuidv7(),
      sessionId: args.sessionId,
      approvalId: args.approvalId,
      choiceId: args.choiceId,
      requirementId: args.requirementId,
    };
    if (args.feedback !== undefined) params.feedback = args.feedback;
    return this.request('approval/decide', params);
  }

  async leave(sessionId: string, stop = true): Promise<any> {
    return this.request('session/leave', { commandId: uuidv7(), sessionId, stop });
  }

  /** End stdin, SIGTERM, SIGKILL after 3s; always resolves once the process is gone. */
  async close(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      proc.once('close', done);
      try {
        proc.stdin?.end();
      } catch {
        /* already gone */
      }
      proc.kill('SIGTERM');
      const t = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 3000);
      t.unref?.();
    });
  }

  /** One line of stdout: a response (routes by id) or an event (fans out). */
  private onLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let obj: any;
    try {
      obj = JSON.parse(text);
    } catch {
      return; // the host sometimes logs plain text; only JSON is the protocol
    }
    if (obj.id !== undefined && this.pending.has(obj.id)) {
      const p = this.pending.get(obj.id)!;
      this.pending.delete(obj.id);
      clearTimeout(p.timer);
      if (obj.error) {
        p.reject(new MspError(p.method, obj.error.code ?? -32000, obj.error.message ?? 'request failed', obj.error.data));
      } else {
        p.resolve(obj.result);
      }
      return;
    }
    if (typeof obj.method === 'string') {
      const ev: MspEvent = { method: obj.method, params: obj.params };
      if (obj.id !== undefined) ev.id = obj.id;
      for (const fn of this.events) {
        try {
          fn(ev);
        } catch {
          /* a dead SSE stream must never break the read loop */
        }
      }
    }
  }

  private failAll(message: string): void {
    if (this.pending.size === 0) return;
    const err = new MspError('serve', -32000, message);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
