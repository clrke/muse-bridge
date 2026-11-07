/**
 * The global event feed behind `GET /feed`: every run's events, for every agent, in one
 * stream with a bridge-wide monotonic `seq`. Kept in memory as a ring buffer (default: the
 * last hour, at most 5000 events) so a client that drops (headset sleep, Wi-Fi blip) can
 * resume with `?after=<seq>` or `Last-Event-ID`.
 *
 * It also tracks the live per-agent state `GET /agents` reports: which runs are in flight
 * (busy), when the agent last ran, and the last thing it said.
 *
 * `seq` restarts at 1 when the bridge restarts. A cursor greater than the current `seq` is
 * therefore from an earlier bridge process, and `since()` replays the whole buffer for it.
 */
export type FeedEventType = 'run' | 'message' | 'tool' | 'agent_done' | 'done' | 'error' | 'aborted' | 'agent_state'
  | BridgeEventType;

/** Bridge-wide events, not tied to one agent's run: `slug` and `runId` are null. */
export type BridgeEventType = 'suggestions' | 'agents_changed';

export interface FeedEvent {
  seq: number;
  /** null on bridge-wide events (`suggestions`, `agents_changed`). */
  slug: string | null;
  runId: string | null;
  type: FeedEventType;
  [key: string]: unknown;
}

type Listener = (ev: FeedEvent) => void;

interface Stamped { ev: FeedEvent; at: number }

const TERMINAL = new Set<FeedEventType>(['done', 'error', 'aborted']);

export class Feed {
  private buffer: Stamped[] = [];
  private seq = 0;
  private listeners = new Set<Listener>();
  /** slug → run ids in flight, oldest first. */
  private active = new Map<string, string[]>();
  private lastRun = new Map<string, number>();
  private lastSpeechBySlug = new Map<string, string>();

  constructor(
    private readonly retainMs = 60 * 60_000,
    private readonly maxEvents = 5000,
    private readonly now: () => number = Date.now,
  ) {}

  /** The newest seq handed out (0 before the first event). */
  get lastSeq(): number {
    return this.seq;
  }

  /** Append one event, notify subscribers and return it. */
  append(slug: string, runId: string, type: FeedEventType, payload: Record<string, unknown> = {}): FeedEvent {
    return this.push(slug, runId, type, payload);
  }

  /** A bridge-wide event (`slug` and `runId` null), e.g. `suggestions` or `agents_changed`. */
  bridgeEvent(type: BridgeEventType, payload: Record<string, unknown> = {}): FeedEvent {
    return this.push(null, null, type, payload);
  }

  private push(slug: string | null, runId: string | null, type: FeedEventType, payload: Record<string, unknown>): FeedEvent {
    const ev: FeedEvent = { seq: ++this.seq, slug, runId, type, ...payload };
    const at = this.now();
    this.buffer.push({ ev, at });
    this.prune(at);
    if (slug && (type === 'message' || type === 'done') && payload.parentId == null) {
      const speech = payload.speech;
      if (typeof speech === 'string' && speech.trim()) this.lastSpeechBySlug.set(slug, speech);
    }
    for (const fn of this.listeners) {
      try { fn(ev); } catch { /* one broken subscriber must not break the run */ }
    }
    return ev;
  }

  /** A run for `slug` started: `run`, then `agent_state {busy:true}`. */
  startRun(slug: string, runId: string, payload: Record<string, unknown> = {}): void {
    const runs = this.active.get(slug) ?? [];
    runs.push(runId);
    this.active.set(slug, runs);
    this.lastRun.set(slug, this.now());
    this.append(slug, runId, 'run', payload);
    this.append(slug, runId, 'agent_state', { busy: true });
  }

  /** A run ended with `done`, `error` or `aborted`, then `agent_state {busy}` (still busy if another run is queued). */
  endRun(slug: string, runId: string, type: 'done' | 'error' | 'aborted', payload: Record<string, unknown> = {}): void {
    if (!TERMINAL.has(type)) throw new Error(`not a terminal feed event: ${type}`);
    const runs = (this.active.get(slug) ?? []).filter(id => id !== runId);
    if (runs.length) this.active.set(slug, runs);
    else this.active.delete(slug);
    this.append(slug, runId, type, payload);
    this.append(slug, runId, 'agent_state', { busy: runs.length > 0 });
  }

  isBusy(slug: string): boolean {
    return (this.active.get(slug)?.length ?? 0) > 0;
  }

  /** The newest in-flight run for `slug`, or null when idle. */
  currentRunId(slug: string): string | null {
    const runs = this.active.get(slug);
    return runs?.length ? runs[runs.length - 1] : null;
  }

  /** When the newest run for `slug` started in this bridge process (ms), or null. */
  lastRunAt(slug: string): number | null {
    return this.lastRun.get(slug) ?? null;
  }

  lastSpeech(slug: string): string | null {
    return this.lastSpeechBySlug.get(slug) ?? null;
  }

  /** Buffered events with seq > after. A cursor from a previous bridge process (after > lastSeq) gets the whole buffer. */
  since(after: number): FeedEvent[] {
    this.prune(this.now());
    const from = after > this.seq ? 0 : after;
    return this.buffer.filter(s => s.ev.seq > from).map(s => s.ev);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  private prune(now: number): void {
    const cutoff = now - this.retainMs;
    let drop = Math.max(0, this.buffer.length - this.maxEvents);
    while (drop < this.buffer.length && this.buffer[drop].at < cutoff) drop++;
    if (drop > 0) this.buffer.splice(0, drop);
  }
}
