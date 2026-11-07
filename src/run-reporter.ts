import { formatForChat, parseJsonResponse, stripJsonParts } from './command-router.js';
import type { Feed } from './feed.js';
import type { JournalEvent, RunJournal } from './run-journal.js';
import type { MessageMeta, ToolUseMeta } from './session-manager.js';
import { toSpeech } from './speech.js';

/** Where a run came from (the `source` field of the feed's `run` event). */
export type RunSource = 'ask' | 'ask/stream' | 'agents' | 'cron';

export interface RunReporterOptions {
  runId: string;
  /** The registered project this run drives, or null for bridge commands (`/list`, …): those are not put on the feed. */
  slug: string | null;
  feed?: Feed;
  source: RunSource;
  /** Every event of the run, in `/ask/stream` shape (journal + open stream). */
  sink?: (data: Record<string, unknown>) => void;
}

export interface FinishExtra {
  projectDirectory?: string | null;
  parked?: boolean;
}

/** Decision and rating of a reply's JSON envelope; both null when the reply isn't JSON. */
export function replyDecision(raw: string | null | undefined): { decision: string | null; rating: number | null } {
  const d = raw ? parseJsonResponse(raw)?.decision : null;
  return d ? { decision: d.summary, rating: d.rating } : { decision: null, rating: null };
}

/**
 * One run's event fan-out. The router's `onMessage` / `onToolUse` / `onFinalPrompt` callbacks
 * go in; out come `/ask/stream`-shaped events for `sink` (JSON envelopes stripped, deduped per
 * speaker, with `speech`) and the contract subset for the global feed, tagged with slug and
 * runId. After `finish()` / `fail()` later callbacks (a timed-out turn still running) are dropped.
 */
export class RunReporter {
  readonly runId: string;
  private readonly sentParts = new Set<string>();
  private mainParts = 0;
  /** The last main-session reply that carried a JSON envelope: the source of done's decision/rating/speech. */
  private lastEnvelope: string | null = null;
  private ended = false;

  constructor(private readonly opts: RunReporterOptions) {
    this.runId = opts.runId;
  }

  get finished(): boolean {
    return this.ended;
  }

  /** Main-session message parts streamed so far. */
  get mainPartsSent(): number {
    return this.mainParts;
  }

  private get fed(): { feed: Feed; slug: string } | null {
    const { feed, slug } = this.opts;
    return feed && slug ? { feed, slug } : null;
  }

  /** Sink-only event (`meta`, `cli_params`, …). */
  emit(data: Record<string, unknown>): void {
    if (!this.ended) this.opts.sink?.(data);
  }

  start(): void {
    this.opts.sink?.({ type: 'run', runId: this.runId });
    this.fed?.feed.startRun(this.fed.slug, this.runId, { source: this.opts.source });
  }

  readonly onMessage = (text: string, meta?: MessageMeta): void => {
    if (this.ended) return;
    const parentId = meta?.parentId ?? null;
    if (!parentId && parseJsonResponse(text)) this.lastEnvelope = text;
    for (const part of stripJsonParts(text)) {
      const formatted = formatForChat(part.trim());
      const norm = formatted.replace(/\s+/g, ' ').trim();
      // Dedup per speaker: a subagent repeating the main session's text still posts.
      const key = norm && `${parentId ?? ''}|${norm}`;
      if (!key || this.sentParts.has(key)) continue;
      this.sentParts.add(key);
      if (!parentId) this.mainParts++;
      const speech = toSpeech(formatted);
      this.opts.sink?.(parentId
        ? { type: 'message', text: formatted, speech, parentId }
        : { type: 'message', text: formatted, speech });
      this.feedAppend('message', { text: formatted, speech, parentId });
    }
  };

  readonly onToolUse = (name: string, detail: string, meta?: ToolUseMeta): void => {
    if (this.ended) return;
    if (meta?.done) {
      const ev = { id: meta.id ?? null, status: meta.status ?? 'completed' };
      this.opts.sink?.({ type: 'agent_done', ...ev });
      this.feedAppend('agent_done', ev);
    } else {
      this.opts.sink?.({ type: 'tool', name, detail, id: meta?.id, parentId: meta?.parentId ?? null });
      this.feedAppend('tool', { name, detail, id: meta?.id ?? null, parentId: meta?.parentId ?? null });
    }
  };

  readonly onFinalPrompt = (text: string): void => {
    this.emit({ type: 'final_prompt', text });
  };

  /** The run finished: `done` (sink: plus singleShot/projectDirectory/parked). */
  finish(response: string, extra: FinishExtra = {}): void {
    if (this.ended) return;
    this.ended = true;
    const formatted = formatForChat(response);
    const envelope = this.lastEnvelope ? parseJsonResponse(this.lastEnvelope) : null;
    const speech = toSpeech(envelope ? envelope.tldr : formatted);
    const { decision, rating } = replyDecision(this.lastEnvelope);
    this.opts.sink?.({
      type: 'done', response: formatted, speech, decision, rating,
      // Nothing was streamed as `message` (e.g. a command reply): the client should show `response`.
      singleShot: this.mainParts === 0,
      projectDirectory: extra.projectDirectory ?? null,
      parked: extra.parked === true,
    });
    if (this.fed) this.fed.feed.endRun(this.fed.slug, this.runId, 'done', { response: formatted, speech, decision, rating });
  }

  /** The run failed: `aborted` for an unexpected process death, else `error`. */
  fail(err: unknown): void {
    if (this.ended) return;
    this.ended = true;
    const msg = (err as Error)?.message ?? String(err);
    if (msg.includes('aborted')) {
      this.opts.sink?.({ type: 'aborted' });
      if (this.fed) this.fed.feed.endRun(this.fed.slug, this.runId, 'aborted');
    } else {
      this.opts.sink?.({ type: 'error', error: msg });
      if (this.fed) this.fed.feed.endRun(this.fed.slug, this.runId, 'error', { error: msg });
    }
  }

  private feedAppend(type: 'message' | 'tool' | 'agent_done', payload: Record<string, unknown>): void {
    if (this.fed) this.fed.feed.append(this.fed.slug, this.runId, type, payload);
  }
}

/**
 * Start-ready reporter for one run: journaled under a fresh run id (so GET /runs/:id/events can
 * resume it) and, for a registered project, put on the feed. `write` also receives each journaled
 * event (an open /ask/stream response).
 */
export function createRun(opts: {
  slug: string | null;
  source: RunSource;
  feed?: Feed;
  journal: RunJournal;
  write?: (ev: JournalEvent) => void;
}): RunReporter {
  const { slug, source, feed, journal, write } = opts;
  const runId = journal.create(slug);
  return new RunReporter({
    runId, slug, feed, source,
    sink: (data) => {
      const ev = journal.append(runId, data);
      if (ev) write?.(ev);
    },
  });
}
