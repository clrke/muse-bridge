/**
 * Project suggestions behind GET /suggestions: scan (discovery.ts), then let Muse rank the
 * candidates and say what seems to be in progress, falling back to the scan's own order.
 *
 * State machine: idle → scanning → ranking → ready | failed. Every change goes to `onChange`
 * (the server puts it on GET /feed as a `suggestions` event).
 */
import path from 'node:path';
import { ago, readmeExcerpt, type Candidate } from './discovery.js';
import { GLOBAL_COMMANDS } from './command-router.js';

export type SuggestionState = 'idle' | 'scanning' | 'ranking' | 'ready' | 'failed';

export interface Suggestion {
  slug: string;
  title: string;
  directory: string;
  /** One line: what seems to be in progress. */
  reason: string;
  /** ISO time of the newest file edit found. */
  lastModified: string;
  /** Up to 3 recently edited files, relative to `directory`, newest first. */
  recentFiles: string[];
}

export interface SuggestionsSnapshot {
  state: SuggestionState;
  /** When the state or the items last changed (ISO), null before the first scan. */
  updatedAt: string | null;
  items: Suggestion[];
  /** False with --no-discover / MUSE_BRIDGE_DISCOVER=0. */
  enabled: boolean;
  /** Set in state `failed`. */
  error?: string;
}

export const MAX_SUGGESTIONS = 5;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_SLUG = 40;

/** A valid project slug from any string, or '' when nothing usable is left. */
export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_SLUG).replace(/-+$/, '');
}

/** True for a slug a suggestion may use: valid, not a bridge command, not taken. */
export function isUsableSlug(slug: string, taken: Set<string>): boolean {
  return SLUG_RE.test(slug) && slug.length <= MAX_SLUG && !(GLOBAL_COMMANDS as readonly string[]).includes(slug) && !taken.has(slug);
}

/** `base` if usable, else `base-2`, `base-3`, … */
export function uniqueSlug(base: string, taken: Set<string>): string {
  const b = slugify(base) || 'project';
  if (isUsableSlug(b, taken)) return b;
  for (let i = 2; ; i++) {
    const s = `${b.slice(0, MAX_SLUG - String(i).length - 1)}-${i}`;
    if (isUsableSlug(s, taken)) return s;
  }
}

const oneLine = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max);

/** "Edited 12 min ago: src/app.ts, README.md" */
export function heuristicReason(c: Candidate, now = Date.now()): string {
  const files = c.recentFiles.slice(0, 3).join(', ');
  return `Edited ${ago(c.lastModified, now)}${files ? `: ${files}` : ''}`;
}

/** The scan's own order, with heuristic reasons. */
export function fallbackSuggestions(cands: Candidate[], taken: Set<string>, now = Date.now(), max = MAX_SUGGESTIONS): Suggestion[] {
  const used = new Set(taken);
  return cands.slice(0, max).map((c) => {
    const slug = uniqueSlug(c.name, used);
    used.add(slug);
    return toSuggestion(c, slug, c.name, heuristicReason(c, now));
  });
}

function toSuggestion(c: Candidate, slug: string, title: string, reason: string): Suggestion {
  return { slug, title, directory: c.directory, reason, lastModified: new Date(c.lastModified).toISOString(), recentFiles: c.recentFiles };
}

export type RankInput = Candidate & { readme: string | null };

/** Everything Muse needs to rank, in the prompt: it runs with no tools. */
export function buildRankPrompt(cands: RankInput[], taken: Set<string>, now = Date.now()): string {
  const blocks = cands.map((c, i) => [
    `## Candidate ${i + 1}`,
    `name: ${c.name}`,
    `directory: ${c.directory}`,
    `last modified: ${new Date(c.lastModified).toISOString()} (${ago(c.lastModified, now)})`,
    `recent files: ${c.recentFiles.join(', ') || '(none found)'}`,
    `README excerpt: ${c.readme ? JSON.stringify(c.readme) : '(none)'}`,
  ].join('\n'));
  return [
    'You are helping a developer pick which of their local projects to open as coding agents.',
    'Do NOT use any tools: everything you need is below. Answer from this text alone.',
    '',
    `Pick up to ${MAX_SUGGESTIONS} of these projects, the ones they most likely want to continue, best first.`,
    'Reply with ONLY a JSON array, no prose, no code fence:',
    '[{"slug":"…","title":"…","directory":"…","reason":"…"}]',
    '- directory: copied exactly from one of the candidates',
    '- slug: short, lowercase letters, digits and dashes only, unique',
    taken.size ? `- slug must not be one of: ${[...taken].sort().join(', ')}` : '',
    '- title: a short human name for the project',
    '- reason: one short line (under 100 characters) about what seems to be in progress',
    '',
    ...blocks,
  ].filter(l => l !== '').join('\n');
}

/** The JSON array in a model reply: bare, fenced, wrapped in `{suggestions:[…]}`, or embedded in prose. */
function extractArray(text: string): unknown[] | null {
  const tries = [text.trim()];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) tries.push(fence[1].trim());
  const a = text.indexOf('['), b = text.lastIndexOf(']');
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) {
    try {
      const j = JSON.parse(t);
      if (Array.isArray(j)) return j;
      if (j && Array.isArray(j.suggestions)) return j.suggestions;
    } catch { /* next */ }
  }
  return null;
}

/**
 * Validate Muse's ranking against the candidates. Items whose `directory` isn't a candidate, or
 * repeats one, are dropped; a bad or clashing slug is replaced by one derived from it (or the
 * folder name). Returns null when nothing usable is left, so the caller falls back.
 */
export function parseRanking(text: string, cands: Candidate[], taken: Set<string>): Suggestion[] | null {
  const arr = extractArray(text);
  if (!arr) return null;
  const byDir = new Map(cands.map(c => [path.resolve(c.directory), c]));
  const used = new Set(taken);
  const dirs = new Set<string>();
  const out: Suggestion[] = [];
  for (const raw of arr) {
    if (out.length >= MAX_SUGGESTIONS) break;
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.directory !== 'string' || !path.isAbsolute(r.directory)) continue;
    const c = byDir.get(path.resolve(r.directory));
    if (!c || dirs.has(c.directory)) continue;
    const want = typeof r.slug === 'string' ? r.slug.trim() : '';
    const slug = isUsableSlug(want, used) ? want : uniqueSlug(slugify(want) || c.name, used);
    const title = typeof r.title === 'string' && r.title.trim() ? oneLine(r.title, 60) : c.name;
    const reason = typeof r.reason === 'string' && r.reason.trim() ? oneLine(r.reason, 140) : heuristicReason(c);
    used.add(slug);
    dirs.add(c.directory);
    out.push(toSuggestion(c, slug, title, reason));
  }
  return out.length ? out : null;
}

export interface SuggestionsDeps {
  enabled: boolean;
  /** Find candidates, leaving out the given (registered) directories. */
  scan: (exclude: string[]) => Promise<Candidate[]>;
  /** Registered projects. */
  registered: () => Promise<{ slug: string; directory: string }[]>;
  /** A read-only Muse turn: prompt in, reply text out (rejects on failure or timeout). Omit to skip ranking. */
  rank?: (prompt: string) => Promise<string>;
  readme?: (dir: string) => Promise<string | null>;
  onChange?: (snap: SuggestionsSnapshot) => void;
  log?: (line: string) => void;
  now?: () => number;
}

export class Suggestions {
  private state: SuggestionState = 'idle';
  private updatedAt: number | null = null;
  private items: Suggestion[] = [];
  private error: string | undefined;
  private running: Promise<SuggestionsSnapshot> | null = null;
  /** Dismissed directories stay hidden on later refreshes (until the bridge restarts). */
  private dismissed = new Set<string>();
  /** Called with the new snapshot on every change (default: `deps.onChange`). */
  onChange?: (snap: SuggestionsSnapshot) => void;

  constructor(private readonly deps: SuggestionsDeps) {}

  get enabled(): boolean {
    return this.deps.enabled;
  }

  snapshot(): SuggestionsSnapshot {
    const s: SuggestionsSnapshot = {
      state: this.state,
      updatedAt: this.updatedAt != null ? new Date(this.updatedAt).toISOString() : null,
      items: this.items.map(i => ({ ...i, recentFiles: [...i.recentFiles] })),
      enabled: this.deps.enabled,
    };
    if (this.error) s.error = this.error;
    return s;
  }

  find(slug: string): Suggestion | undefined {
    return this.items.find(i => i.slug === slug);
  }

  /** Re-run discovery (joins a run already in progress). */
  refresh(): Promise<SuggestionsSnapshot> {
    if (!this.deps.enabled) return Promise.resolve(this.snapshot());
    this.running ??= this.run().finally(() => { this.running = null; });
    return this.running;
  }

  /** Drop a suggestion (accepted or dismissed). Returns false for an unknown slug. */
  remove(slug: string, opts: { dismiss?: boolean } = {}): boolean {
    const item = this.find(slug);
    if (!item) return false;
    if (opts.dismiss) this.dismissed.add(item.directory);
    this.items = this.items.filter(i => i !== item);
    this.changed();
    return true;
  }

  /** Drop suggestions whose directory or slug got registered some other way (e.g. /register). */
  async pruneRegistered(): Promise<void> {
    const reg = await this.deps.registered();
    const dirs = new Set(reg.map(r => path.resolve(r.directory)));
    const slugs = new Set(reg.map(r => r.slug));
    const left = this.items.filter(i => !dirs.has(path.resolve(i.directory)) && !slugs.has(i.slug));
    if (left.length !== this.items.length) {
      this.items = left;
      this.changed();
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private log(line: string): void {
    (this.deps.log ?? console.log)(`[Suggestions] ${line}`);
  }

  private changed(): void {
    this.updatedAt = this.now();
    try { (this.onChange ?? this.deps.onChange)?.(this.snapshot()); } catch { /* a listener must not break discovery */ }
  }

  private set(state: SuggestionState, extra: { items?: Suggestion[]; error?: string } = {}): void {
    this.state = state;
    if (extra.items) this.items = extra.items;
    this.error = extra.error;
    this.changed();
  }

  private async run(): Promise<SuggestionsSnapshot> {
    const started = this.now();
    this.set('scanning');
    try {
      const reg = await this.deps.registered();
      const taken = new Set(reg.map(r => r.slug));
      const cands = (await this.deps.scan(reg.map(r => r.directory))).filter(c => !this.dismissed.has(c.directory));
      this.log(`scan found ${cands.length} candidate(s) in ${this.now() - started} ms`);
      if (!cands.length) {
        this.set('ready', { items: [] });
        return this.snapshot();
      }
      let items: Suggestion[] | null = null;
      if (this.deps.rank) {
        this.set('ranking');
        try {
          const readme = this.deps.readme ?? readmeExcerpt;
          const input = await Promise.all(cands.map(async c => ({ ...c, readme: await readme(c.directory).catch(() => null) })));
          const reply = await this.deps.rank(buildRankPrompt(input, taken, this.now()));
          items = parseRanking(reply, cands, taken);
          if (!items) this.log(`Muse's ranking was not usable JSON, using recency order: ${reply.slice(0, 200).replace(/\s+/g, ' ')}`);
        } catch (err) {
          this.log(`Muse ranking failed, using recency order: ${(err as Error).message}`);
        }
      }
      this.set('ready', { items: items ?? fallbackSuggestions(cands, taken, this.now()) });
    } catch (err) {
      this.log(`discovery failed: ${(err as Error).message}`);
      this.set('failed', { items: [], error: (err as Error).message });
    }
    return this.snapshot();
  }
}
