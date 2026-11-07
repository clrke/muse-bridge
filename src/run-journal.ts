import crypto from 'node:crypto';

/**
 * In-memory journal of every SSE event an /ask/stream run emits, so a client whose
 * connection drops mid-run (network blip, UND_ERR_SOCKET, body timeout) can reconnect via
 * GET /runs/:id/events?after=<seq> and receive what it missed, then the rest live. The
 * `muse` process is not tied to the HTTP connection, so without this its later output would
 * be written to a dead response and lost.
 *
 * Memory only, on purpose: a bridge restart kills the runs anyway. Finished runs are kept
 * for `retainMs` (default 1 hour).
 */
export interface JournalEvent {
  seq: number;
  data: Record<string, unknown>;
}

type Listener = (ev: JournalEvent) => void;

interface Run {
  id: string;
  slug: string | null;
  events: JournalEvent[];
  seq: number;
  done: boolean;
  finishedAt: number | null;
  listeners: Set<Listener>;
}

/** Terminal SSE event types: after one of these the run is complete. */
const TERMINAL = new Set(['done', 'error', 'aborted']);

export class RunJournal {
  private runs = new Map<string, Run>();

  constructor(
    private readonly retainMs = 60 * 60_000,
    private readonly maxEvents = 20_000,
    private readonly now: () => number = Date.now,
  ) {}

  create(slug: string | null): string {
    this.prune();
    const id = crypto.randomUUID();
    this.runs.set(id, { id, slug, events: [], seq: 0, done: false, finishedAt: null, listeners: new Set() });
    return id;
  }

  /** Record an event, notify live listeners, and return it with its sequence number. */
  append(id: string, data: Record<string, unknown>): JournalEvent | null {
    const run = this.runs.get(id);
    if (!run || run.done) return null;
    const ev: JournalEvent = { seq: ++run.seq, data };
    run.events.push(ev);
    // Bound memory on pathological runs: keep the newest; a resume from before the cut
    // just misses the oldest events (it still gets everything after).
    if (run.events.length > this.maxEvents) run.events.splice(0, run.events.length - this.maxEvents);
    if (typeof data.type === 'string' && TERMINAL.has(data.type)) {
      run.done = true;
      run.finishedAt = this.now();
    }
    for (const l of run.listeners) l(ev);
    if (run.done) run.listeners.clear();
    return ev;
  }

  has(id: string): boolean {
    return this.runs.has(id);
  }

  isDone(id: string): boolean {
    return this.runs.get(id)?.done ?? true;
  }

  /** Events with seq > after. */
  since(id: string, after: number): JournalEvent[] {
    return this.runs.get(id)?.events.filter(e => e.seq > after) ?? [];
  }

  /** Live events from now on; returns an unsubscribe function. No-op for finished runs. */
  subscribe(id: string, fn: Listener): () => void {
    const run = this.runs.get(id);
    if (!run || run.done) return () => {};
    run.listeners.add(fn);
    return () => run.listeners.delete(fn);
  }

  /** Drop finished runs older than the retention window. */
  prune(): void {
    const cutoff = this.now() - this.retainMs;
    for (const [id, run] of this.runs) {
      if (run.done && run.finishedAt != null && run.finishedAt < cutoff) this.runs.delete(id);
    }
  }
}
