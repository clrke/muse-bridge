import fs from 'node:fs/promises';
import path from 'node:path';
import type { AskPayload, ProjectConfig, ProjectResponse } from './types.js';
import type { SessionManager } from './session-manager.js';
import { PROJECT_NOTES_DIR, type ProjectStore } from './project-store.js';
import { calculateDeadline, ratingToHours, extendDeadline, pauseForVacation, deadlineFromActiveHours } from './deadline.js';

/** Coerce a parsed JSON object into a ProjectResponse with a guaranteed-string `tldr`.
 *  The model occasionally emits `tldr` as a non-string (object/number/array) — e.g.
 *  `"tldr": {…}` — which would blow up any downstream `.replace`/string op. Normalize
 *  it here so every consumer can treat `tldr` as a string.
 *
 *  Wire format is flat — top-level `decision` (string) + `rating` (number), plus optional
 *  `other_findings` and `assumptions_made` — but every downstream consumer (extractDecision,
 *  ProjectConfig storage, ratingToHours, runProsCons, etc.) expects the pre-existing nested
 *  `{summary, rating}` shape. Reconstruct that here so the wire-format change stays isolated
 *  to this one boundary function. */
function asProjectResponse(parsed: Record<string, unknown>): ProjectResponse {
  const m = parsed.tldr;
  const tldr = typeof m !== 'string'
    ? (m == null ? '' : typeof m === 'object' ? JSON.stringify(m) : String(m))
    : m;

  const rawDecision = parsed.decision;
  const rawRating = parsed.rating;
  let decision: { summary: string; rating: number } | null = null;
  if (typeof rawDecision === 'string' && typeof rawRating === 'number') {
    decision = { summary: rawDecision, rating: rawRating };
  } else if (
    rawDecision && typeof rawDecision === 'object' &&
    typeof (rawDecision as Record<string, unknown>).summary === 'string' &&
    typeof (rawDecision as Record<string, unknown>).rating === 'number'
  ) {
    // Backward-compat: tolerate the legacy nested {summary,rating} shape in case a
    // session's context still recalls the old format before it picks up the new one.
    decision = {
      summary: (rawDecision as Record<string, unknown>).summary as string,
      rating: (rawDecision as Record<string, unknown>).rating as number,
    };
  }

  const rawOther = parsed.other_findings;
  const otherFindings = typeof rawOther === 'string' && rawOther.trim() !== '' ? rawOther : undefined;

  const rawAssumptions = parsed.assumptions_made;
  const assumptionsMade = typeof rawAssumptions === 'string' && rawAssumptions.trim() !== '' ? rawAssumptions : undefined;

  return { tldr, otherFindings, assumptionsMade, decision };
}

/** Parse an agent response that may contain JSON with tldr and decision fields */
export function parseJsonResponse(text: string): ProjectResponse | null {
  const trimmed = text.trim();

  // 1. Try markdown code fence first: ```json { ... } ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (parsed.tldr !== undefined) return asProjectResponse(parsed);
    } catch { /* fall through */ }
  }

  // 2. Try raw JSON: { ... }
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.tldr !== undefined) return asProjectResponse(parsed);
    } catch { /* fall through */ }
  }

  // 3. Try to find {"tldr" later in the text and parse from there
  const jsonStart = trimmed.indexOf('{"tldr"');
  if (jsonStart > 0) {
    try {
      const parsed = JSON.parse(trimmed.slice(jsonStart));
      if (parsed.tldr !== undefined) return asProjectResponse(parsed);
    } catch { /* fall through */ }
  }

  // 4. Lenient fallback: truncated JSON ({"tldr": "...) where the streamed
  // response was cut off mid-string (max output tokens, network drop, etc).
  // Pull the tldr field as far as it goes; decision is unrecoverable so null.
  const lenientStart = trimmed.indexOf('{"tldr"');
  if (lenientStart >= 0) {
    const slice = trimmed.slice(lenientStart);
    const m = slice.match(/^\{"tldr"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (m) {
      try {
        // JSON.parse handles all valid escape sequences (\n, \", \\, \uXXXX, etc.)
        const tldr = JSON.parse(`"${m[1]}"`);
        return { tldr, decision: null };
      } catch {
        // Couldn't unescape (probably broken mid-escape) — return raw chars; better than showing the JSON wrapper
        return { tldr: m[1], decision: null };
      }
    }
  }

  return null;
}

/** Strips the JSON envelope from an agent response, leaving only the human-readable tldr.
 *  Pre-JSON preamble (if any) is kept as the first part; the extracted tldr is last. */
export function stripJsonParts(text: string): string[] {
  const trimmed = text.trim();
  const parsed = parseJsonResponse(trimmed);
  if (!parsed) return [text];

  const jsonStart = trimmed.indexOf('{"tldr"');
  const fenceStart = trimmed.search(/```(?:json)?\s*\{/);
  const cutPoint = fenceStart >= 0 ? fenceStart : jsonStart;

  const parts: string[] = [];
  if (cutPoint > 0) {
    const prefix = trimmed.slice(0, cutPoint).trim();
    if (prefix) parts.push(prefix);
  }
  if (parsed.tldr) {
    // Strip TLDR prefixes the agent may add on its own
    const clean = parsed.tldr.replace(/^(?:__\*\*TLDR\*\*__|#+\s*TLDR)\s*/i, '').trim();
    parts.push(`# TLDR\n${clean}`);
  }
  if (parsed.otherFindings) {
    parts.push(`# Other Findings\n${parsed.otherFindings}`);
  }
  if (parsed.assumptionsMade) {
    parts.push(`# Assumptions Made\n${parsed.assumptionsMade}`);
  }
  return parts.length > 0 ? parts : [text];
}

export function stripJson(text: string): string {
  return stripJsonParts(text).join('\n\n');
}

/** Wrap arbitrary text in a single backtick code span for the ⏳/⏸️ notices below — but
 *  only when the text itself contains no backticks. A decision summary that already
 *  contains its own inline code spans (e.g. "Merge with `gh pr merge 80`") would
 *  otherwise close the outer span at its first backtick, splitting the notice into a
 *  broken jumble of alternating code/plain-text fragments instead of one readable line.
 *  Falls back to the raw, unwrapped text so any inner code spans render correctly. */
function safeBacktickWrap(text: string): string {
  return text.includes('`') ? text : `\`${text}\``;
}

/**
 * Light chat formatting: markdown tables become key-value lines (tables render badly in most
 * chat surfaces and in speech), and emails / international phone numbers become links.
 */
export function formatForChat(text: string): string {
  // Cell parser that honors `\|` (escape syntax) and pipes inside `…` (inline
  // code spans) as LITERAL, not as delimiters. The naive `row.split('|')` shreds
  // any cell whose code sample contains pipes — exactly what produced the
  // mangled output when a 3-col table had a backticked example with `\|` in it
  // (cells beyond the header count fell through as orphan bare lines).
  const parseRow = (row: string): string[] => {
    const cells: string[] = [];
    let cur = '';
    let inBacktick = false;
    for (let i = 0; i < row.length; i++) {
      const c = row[i];
      // Escaped pipe: consume both chars, emit literal '|' into the cell
      if (c === '\\' && row[i + 1] === '|') {
        cur += '|';
        i++;
        continue;
      }
      // Backtick toggles "inside inline code span" state
      if (c === '`') {
        inBacktick = !inBacktick;
        cur += c;
        continue;
      }
      // Pipe acts as a delimiter ONLY outside backtick spans
      if (c === '|' && !inBacktick) {
        cells.push(cur);
        cur = '';
        continue;
      }
      cur += c;
    }
    cells.push(cur);
    // Drop the leading/trailing empties that come from the outer `|`s, then trim each cell
    return cells.slice(1, -1).map(c => c.trim());
  };

  // Pass 1: standard headed tables (header + separator + data rows).
  let out = text.replace(
    /((?:^|\n)\|.+\|(?:\n\|[-:| ]+\|)(?:\n\|.+\|)+)/g,
    (table) => {
      const lines = (table.startsWith('\n') ? table.slice(1) : table).split('\n');
      const headers = parseRow(lines[0]);
      const dataRows = lines.slice(2).map(parseRow);

      // Defensive: if any data row's cell count doesn't match the header count,
      // the parser couldn't disambiguate something (most often: an unbalanced
      // backtick that left `inBacktick` stuck on, swallowing later pipes).
      // Leave the table alone rather than emit garbled output.
      if (dataRows.some(r => r.length !== headers.length)) return table;

      return '\n' + dataRows.map(cells =>
        cells.map((cell, i) => {
          const header = headers[i];
          return header ? `**${header}:** ${cell}` : cell;
        }).join('\n')
      ).join('\n\n');
    },
  );

  // Pass 2: header-less 2-column tables. Markdown requires a separator row, so
  // `| key | val |\n| key | val |` (no `| --- | --- |`) renders verbatim with
  // ugly literal pipes. Treat it as a key:value list — each row → `**key:** val`.
  // Constraints:
  //   - exactly 2 cells per row (3+ columns can't be unambiguously key:value'd)
  //   - non-empty cells (so `| | |` doesn't match)
  //   - ≥ 2 rows (so a stray `| a | b |` line in prose doesn't get rewritten)
  //   - bail out if any row looks like a markdown separator (all `-`/`:`/space) —
  //     that indicates a malformed headed table we shouldn't touch
  out = out.replace(
    /((?:^|\n)\|[^\n|]+\|[^\n|]+\|(?:\n\|[^\n|]+\|[^\n|]+\|)+)/g,
    (table) => {
      const block = table.startsWith('\n') ? table.slice(1) : table;
      const lines = block.split('\n');
      const parseRow = (row: string) => row.split('|').slice(1, -1).map(c => c.trim());
      const rows = lines.map(parseRow);
      // If any row is a separator (e.g. `| --- | --- |`), this is a malformed
      // headed table — leave it alone for the human to fix.
      if (rows.some(r => r.every(c => /^[-:\s]+$/.test(c) && c.length > 0))) return table;
      return '\n' + rows.map(([k, v]) => `**${k}:** ${v}`).join('\n');
    },
  );

  // Pass 3: auto-linkify emails and international phone numbers so they're tappable
  // in chat apps. URLs are skipped: most clients auto-linkify plain
  // http(s) URLs without help. Content inside code spans, fenced blocks, and
  // existing markdown links is protected from transformation.
  out = autoLinkify(out);

  return out;
}

/**
 * Wrap emails and international phone numbers (those starting with `+`) in
 * markdown links so chat apps make them tappable. Skips content
 * inside code spans, fenced code blocks, and existing markdown links — those
 * are either explicit code or already-formatted links and shouldn't be touched.
 *
 * Phone constraint: must start with `+` (E.164-ish) AND have 8–15 digits total.
 * Bare numbers like `555-1234` are ambiguous (could be a date, version, ID, etc.)
 * and stay alone. URLs are not wrapped: clients handle them natively, and
 * wrapping `[https://x](https://x)` adds noise without changing behavior.
 */
function autoLinkify(text: string): string {
  const PROTECTED: string[] = [];
  const placeholder = (i: number) => ` PROT${i} `;
  let processed = text;

  const protect = (re: RegExp) => {
    processed = processed.replace(re, (match) => {
      const i = PROTECTED.length;
      PROTECTED.push(match);
      return placeholder(i);
    });
  };

  // Order matters: fenced blocks first (longest match wins), then inline code,
  // then existing markdown links. Each pass operates on already-redacted text.
  protect(/```[\s\S]*?```/g);
  protect(/`[^`\n]+`/g);
  protect(/\[[^\]]+\]\([^)]+\)/g);

  // Emails: standard local@domain.tld shape; word boundaries prevent gobbling
  // trailing punctuation ("foo@bar.com." → leaves the trailing period alone).
  processed = processed.replace(
    /\b([\w.+-]+@[\w-]+(?:\.[\w-]+)+)\b/g,
    (m) => `[${m}](mailto:${m})`,
  );

  // International phones: must start with `+`, must end on a digit (so we don't
  // gobble a trailing `)` from "(+1-555-1234)"), and total digit count must be
  // 8–15 (E.164 spec). Anything outside that range is treated as not-a-phone.
  processed = processed.replace(
    /\+\d[\d\s().\-]{5,18}\d/g,
    (m) => {
      const digits = m.replace(/\D/g, '');
      if (digits.length < 8 || digits.length > 15) return m;
      return `[${m}](tel:+${digits})`;
    },
  );

  // Restore protected regions in their original positions.
  return processed.replace(/ PROT(\d+) /g, (_, idx) => PROTECTED[Number(idx)]);
}

export function extractDecision(text: string): { summary: string; rating: number } | null {
  const parsed = parseJsonResponse(text);
  return parsed?.decision ?? null;
}

function formatTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function relativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

/** Returns wall-clock time remaining until a deadline fires (e.g. "in 3h", "in 45m", "overdue"). */
export function timeUntil(deadline: string): string {
  const diffMs = new Date(deadline).getTime() - Date.now();
  if (diffMs <= 0) return 'overdue';
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  const days = Math.round(hrs / 24);
  return `in ${days}d`;
}
const PROJECT_SYSTEM_PROMPT = `Your response must be valid JSON in this exact format:
{"tldr": "your response here", "other_findings": "secondary details/context not central to the tldr, or empty string if none", "assumptions_made": "assumptions you made while answering, or empty string if none", "decision": "what to do next", "rating": 0}

Formatting: output is shown in a chat or VR client. Markdown tables are fine (they are converted to key-value lines). When listing local files you produced (generated assets, output files), put each absolute path on its own plain line, not inside a triple-backtick code fence, so clients can pick them up.

Always fill in decision: after completing any work, suggest what to do next and rate its impact. The bridge reads it to decide whether to auto-continue, so a missing one stalls the project.

Rate decisions 0-10:
- 0: trivial continuation of the current task (e.g. "continue translating the rest?", "proceed with commit?"). System auto-continues immediately.
- 1-3: low impact, needs brief user input (variable naming, minor config choices)
- 4-6: moderate impact, needs details (which approach to refactor, feature design)
- 7-9: high impact, needs human judgment (architecture, framework choice, API design)
- 10: critical, irreversible (breaking changes, data migration, deleting data)

If multiple decisions needed, combine into one question.
Document the user's response to ${PROJECT_NOTES_DIR}/PROJECT_DECISIONS.md if needed.`;

/** Appended to work prompts: Muse has its own subagents (`subagent_spawn`). */
const SUBAGENT_HINT = '\n\nUse subagents for wide or independent work (searches, test runs, per-file checks, parallel investigation).';
const AUTO_DECIDE_PROMPT = `Make an informed decision for me${SUBAGENT_HINT}`;

/** True for the two documented JSON-free response shapes: the bare `NO_CONS` token and the
 *  strict `PROS:`/`CONS:` bullet format, both used by the "why are you asking me — real cons?"
 *  behavioural test (see PROJECT_SYSTEM_PROMPT's sibling instruction). Both are intentionally
 *  JSON-free, so the missing-envelope reprompt below must never fire on them. */
export function isJsonEnvelopeExempt(text: string): boolean {
  const trimmed = text.trim();
  if (/^NO_CONS$/.test(trimmed)) return true;
  return /^PROS:/m.test(trimmed) && /^CONS:/m.test(trimmed);
}

/** Sent once when a response has no parseable {tldr, decision} JSON at all (and isn't one
 *  of the exempt shapes above) — asks the agent to resend in the required format and reminds it
 *  to keep including it going forward. */
const MISSING_JSON_ENVELOPE_REPROMPT =
  'Your last reply did not include the required `{"tldr": "...", "other_findings": "...", "assumptions_made": "...", "decision": "...", "rating": 0-10}` ' +
  'JSON envelope. Please resend your last answer wrapped in that exact JSON format now, and remember to include it ' +
  'in every reply going forward.';

/** Responses that mean the agent is idle — nudge immediately instead of waiting */
const STALL_RESPONSES = [
  'All tasks complete.',
  'All done.',
  'Nothing to do.',
  'Waiting for instructions.',
];

// "For later:" (+ aliases) — a message a user parks while the agent is mid-work.
// Held at the bridge (never triggers a query, which would kill the in-flight
// process) until the current run pauses (auto-decide loop ends: real pros/cons or
// a rating > 0 decision), then injected with this reframe so the agent documents the
// pause, then works the parked item next (not immediately mid-stream). Any of these
// colon-prefixes trigger it.
const FOR_LATER_RE =
  /^\s*(?:for\s+later|later|todo|to-do|backlog|defer|parking\s+lot|park(?:\s+this)?|queue(?:\s+this)?|not\s+now)\s*:\s*([\s\S]*)$/i;
const FOR_LATER_RESUME_PREFIX =
  "Hold off on this for now and document it so we can resume later. Streamline this moving forward. Drop any obsolete documentation. After you're done with that, work on this next:\n\n";
// Several "For later:" tasks queued during one run are released together as one turn
// (one doc pass, one decision) rather than N noisy turns. Body is a numbered list.
const FOR_LATER_RESUME_PREFIX_PLURAL =
  "Hold off on these for now and document them so we can resume later. Streamline this moving forward. Drop any obsolete documentation. After you're done with that, work on these next:\n\n";

// "Effort: <level>" anywhere in a message sets `muse exec --reasoning-effort` for that turn.
// Skipped when wrapped in quotes/backticks so quoting or documenting the syntax is inert;
// the `<level>` placeholder never matches because only real levels are accepted.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_RE = /[ \t]*(?<![`"'\u201c\u2018])\beffort[ \t]*:[ \t]*(low|medium|high|xhigh|max)\b(?![`"'\u201d\u2019])[ \t]*(\r?\n)?/gi;

/**
 * Pull every `Effort: <level>` token out of a message. The highest level mentioned wins
 * (a drained batch can carry several); the tokens are removed from the returned text.
 */

export function parseEffort(text: string): { effort?: string; text: string } {
  let best = -1;
  const out = text.replace(EFFORT_RE, (match: string, level: string, nl: string | undefined, offset: number, whole: string) => {
    best = Math.max(best, EFFORT_LEVELS.indexOf(level.toLowerCase()));
    const before = whole[offset - 1];
    const startsLine = before === undefined || before === '\n';
    if (nl) return startsLine ? '' : nl; // own line: drop it whole; end of a line: keep the break
    const after = whole[offset + match.length];
    const inline = !startsLine && after !== undefined && !/[.,;:!?)]/.test(after);
    return inline ? ' ' : '';
  });
  if (best < 0) return { text };
  return { effort: EFFORT_LEVELS[best], text: out.replace(/\n{3,}/g, '\n\n').trim() };
}

// "Continuation:" (+ aliases) — queued exactly like "For later:" (parked while a run is in
// flight, drained when it pauses, run immediately when idle) but released WITHOUT the
// hold-off/document-the-pause reframe: it's a follow-on to the current work, not a detour
// that shelves it. Idle → the bare task runs as-is.
const CONTINUATION_RE =
  /^\s*(?:continuation|continue\s+with|after\s+that|afterwards|next\s+up)\s*:\s*([\s\S]*)$/i;
const CONTINUATION_PREFIX = 'Continue with this next:\n\n';
const CONTINUATION_PREFIX_PLURAL = 'Continue with these next:\n\n';
// A mixed drain (both kinds parked during one run) keeps the hold-off reframe scoped to the
// "For later:" items and appends the continuations after them.
const CONTINUATION_AFTER_LATER = '\n\nThen continue with:\n\n';

export type QueuedTaskKind = 'later' | 'continuation';
export interface QueuedTask { kind: QueuedTaskKind; task: string }

/** Classify a project message as a queueable "For later:"/"Continuation:" task, or null. */
export function parseQueuedTask(args: string): QueuedTask | null {
  const later = args.match(FOR_LATER_RE);
  if (later) return { kind: 'later', task: later[1].trim() };
  const cont = args.match(CONTINUATION_RE);
  if (cont) return { kind: 'continuation', task: cont[1].trim() };
  return null;
}

const numbered = (tasks: string[]) =>
  tasks.length > 1 ? tasks.map((t, i) => `${i + 1}. ${t}`).join('\n') : tasks[0];

/** Build the single drain turn for everything parked during one run (queue order kept per kind). */
export function buildQueuedDrainPrompt(batch: QueuedTask[]): string {
  const later = batch.filter(b => b.kind === 'later').map(b => b.task);
  const cont = batch.filter(b => b.kind === 'continuation').map(b => b.task);
  if (later.length === 0) {
    return (cont.length > 1 ? CONTINUATION_PREFIX_PLURAL : CONTINUATION_PREFIX) + numbered(cont);
  }
  const head = (later.length > 1 ? FOR_LATER_RESUME_PREFIX_PLURAL : FOR_LATER_RESUME_PREFIX) + numbered(later);
  return cont.length ? head + CONTINUATION_AFTER_LATER + numbered(cont) : head;
}

// Wrap-up digest. An exchange that needed MORE than one model round-trip — a pros/cons
// detour, one or more rating-0 auto-decide laps, or a drained "For later:" batch — ends
// with a single summary turn instead of just going quiet mid-thread. A plain one-shot
// Q&A is left alone. Counted at the queryCounted chokepoint, which every round-trip
// (primary query, stall nudge, pros/cons, "what do you suggest?", envelope reprompt,
// each auto-decide lap, each drain turn) passes through exactly once.
const WRAPUP_MIN_ROUND_TRIPS = 1;
const buildWrapupPrompt = (since: string) =>
  `Summarize what has been done since ${since} and enumerate next steps. `
  + 'Respond with tldr, assumptions and rating 10.';
/** Chat commands handled by the bridge itself (everything else is `/<project-slug> <text>`). */
export const GLOBAL_COMMANDS = ['list', 'details', 'info', 'register', 'reset', 'nudge', 'vacation', 'unvacation', 'auto-decide-extend', 'help'] as const;

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

type OnMessage = (text: string, meta?: { parentId: string }) => void;
type OnToolUse = (name: string, detail: string, meta?: { id?: string; parentId?: string | null; done?: boolean; status?: string }) => void;
type OnFinalPrompt = (text: string) => void;

export interface HandleResult {
  response: string;
  projectSlug?: string;
  /** The message was parked behind a running turn ("For later:"/"Continuation:"), no turn ran. */
  parked?: boolean;
}

export class CommandRouter {
  /** Slugs with a project turn currently running (used to hold "For later:" messages). */
  private inFlight = new Set<string>();
  /** Per-slug queue of parked "For later:" tasks, drained when the in-flight run pauses. */
  private deferredTasks = new Map<string, QueuedTask[]>();
  /** Model round-trips so far in the current exchange, per slug. */
  private exchangeRoundTrips = new Map<string, number>();
  /** Wall-clock start of the current exchange, per slug (when the user's prompt landed). */
  private exchangeStartedAt = new Map<string, Date>();
  /** Slugs currently running their wrap-up digest (guards against the digest recursing). */
  private wrappingUp = new Set<string>();
  /** Slugs whose turn ended via a deliberate safety guard (stall detector or kill switch):
   *  the wrap-up digest must stand down rather than overwrite their decision. */
  private guardTripped = new Set<string>();

  /** Called after a project is registered (the server turns it into a feed `agents_changed`). */
  onAgentsChanged?: () => void;

  constructor(
    private sessionManager: SessionManager,
    private projectStore: ProjectStore,
  ) {}

  async handle(
    payload: AskPayload,
    onMessage?: OnMessage,
    onToolUse?: OnToolUse,
    onFinalPrompt?: OnFinalPrompt,
  ): Promise<HandleResult> {
    const text = payload.trigger.originalMessage.trim();
    const { command, args } = this.parseCommand(text);

    switch (command) {
      case 'list': return this.handleList();
      case 'details':
      case 'info': return this.handleDetails(args);
      case 'register': return this.handleRegister(args);
      case 'vacation': return this.handleVacation();
      case 'unvacation': return this.handleUnvacation();
      case 'auto-decide-extend': return this.handleAutoDecideExtend(args);
      case 'reset': return this.handleReset(args);
      case 'nudge': return this.handleNudge(args, onMessage, onToolUse, onFinalPrompt);
      case 'help': return this.handleHelp();
      case '': return { response: 'Start a message with /<project> (e.g. `/my-app add a jump button`), or send /help.' };
      default: {
        const project = await this.projectStore.load(command);
        if (project) return this.handleProject(project, args, onMessage, onToolUse, onFinalPrompt);
        return { response: `Unknown command: /${command}` };
      }
    }
  }

  private parseCommand(text: string): { command: string; args: string } {
    const match = text.match(/^\/([a-z0-9-]+)\s*([\s\S]*)$/i);
    if (!match) return { command: '', args: text };
    return { command: match[1].toLowerCase(), args: match[2].trim() };
  }

  private async handleList(): Promise<HandleResult> {
    const projects = await this.projectStore.loadAll();
    if (projects.length === 0) return { response: 'No projects registered. Use /register <slug> <directory> [title] to add one.' };

    const lines = projects.map(p => {
      const idle = p.lastConversationAt ? ` · ${relativeTime(new Date(p.lastConversationAt))}` : '';
      let statusLine: string;
      if (p.decision) {
        const summary = p.decision.summary.slice(0, 60);
        const countdown = p.decision.rating < 10 && p.decision.deadline
          ? ` · ${timeUntil(p.decision.deadline)}`
          : ' · waiting for you';
        statusLine = `⏳ *${summary}*${countdown}`;
      } else {
        statusLine = p.status.length > 70 ? p.status.slice(0, 67) + '…' : p.status;
      }
      return `**${p.title}** /${p.slug}\n${statusLine}${idle}`;
    });
    return { response: lines.join('\n\n') };
  }

  private async handleDetails(filter?: string): Promise<HandleResult> {
    let projects = await this.projectStore.loadAll();
    if (projects.length === 0) return { response: 'No projects registered.' };
    if (filter) {
      const slug = filter.trim().toLowerCase();
      projects = projects.filter(p => p.slug === slug);
      if (projects.length === 0) return { response: `Project "${slug}" not found. Use /list to see all projects.` };
    }

    const sections = projects.map(p => {
      const lastActive = p.lastConversationAt ? relativeTime(new Date(p.lastConversationAt)) : 'never';
      const lines = [
        `**${p.title}**`,
        `Command: /${p.slug}`,
        `Directory: ${p.directory}`,
        `Description: ${p.description}`,
        `Status: ${p.status}`,
        `Auto-decide: ${p.autoDecide ? 'yes' : 'no'}`,
        `Session: ${p.sessionId ? `active (${p.sessionId.slice(0, 8)}…)` : 'none'}`,
        `Last active: ${lastActive}`,
      ];
      if (p.decision) {
        lines.push(`Decision: ${p.decision.summary} (rating: ${p.decision.rating})`);
        lines.push(`Deadline: ${p.decision.deadline}`);
      }
      return lines.join('\n');
    });
    return { response: sections.join('\n\n') };
  }

  /** `/register <slug> <absolute-directory> [title…]`: deterministic, no model turn. */
  private async handleRegister(args: string): Promise<HandleResult> {
    const usage = 'Usage: /register <slug> <absolute-directory> [title]';
    const m = args.match(/^(\S+)\s+(?:"([^"]+)"|(\S+))\s*([\s\S]*)$/);
    if (!m) return { response: usage };
    const slug = m[1].toLowerCase();
    const directory = m[2] ?? m[3];
    const r = await this.registerProject(slug, directory, m[4].trim() || slug);
    if (!r.ok) return { response: r.code === 'directory' && !path.isAbsolute(directory) ? `${r.error} ${usage}` : r.error };
    const { project } = r;
    return { response: `Project registered!\nTitle: ${project.title}\nCommand: /${project.slug}\nDirectory: ${project.directory}`, projectSlug: slug };
  }

  /**
   * Register a project (the `/register` code path, also used to accept a suggestion).
   * `code` on failure: `slug` (invalid or reserved), `directory` (not an absolute existing
   * directory) or `exists` (the slug is taken).
   */
  async registerProject(slug: string, directory: string, title?: string): Promise<
    { ok: true; project: ProjectConfig } | { ok: false; code: 'slug' | 'directory' | 'exists'; error: string }
  > {
    if (!SLUG_RE.test(slug)) return { ok: false, code: 'slug', error: `Invalid slug "${slug}": use lowercase letters, digits and dashes.` };
    if ((GLOBAL_COMMANDS as readonly string[]).includes(slug)) return { ok: false, code: 'slug', error: `"${slug}" is a bridge command and can't be a project slug.` };
    if (!path.isAbsolute(directory)) return { ok: false, code: 'directory', error: 'Directory must be an absolute path.' };
    const stat = await fs.stat(directory).catch(() => null);
    if (!stat?.isDirectory()) return { ok: false, code: 'directory', error: `Directory not found: ${directory}` };
    if (await this.projectStore.load(slug)) return { ok: false, code: 'exists', error: `Project /${slug} already exists.` };

    const project = await this.projectStore.create({ title: title?.trim() || slug, slug, description: '', directory, autoDecide: false });
    try { this.onAgentsChanged?.(); } catch { /* a listener must not fail the registration */ }
    return { ok: true, project };
  }

  private async handleVacation(): Promise<HandleResult> {
    if (await this.projectStore.isVacation()) return { response: 'Already on vacation mode.' };
    const projects = await this.projectStore.loadAll();
    const now = new Date();
    for (const project of projects) {
      if (project.decision?.deadline) {
        project.decision.pausedRemaining = pauseForVacation(project.decision.deadline, now);
        project.decision.deadline = '';
        await this.projectStore.save(project);
      }
    }
    await this.projectStore.setVacation(true);
    return { response: 'Vacation mode ON. All auto-decide timers paused.' };
  }

  private async handleUnvacation(): Promise<HandleResult> {
    if (!(await this.projectStore.isVacation())) return { response: 'Not in vacation mode.' };
    const projects = await this.projectStore.loadAll();
    const now = new Date();
    for (const project of projects) {
      if (project.decision?.pausedRemaining != null) {
        project.decision.deadline = deadlineFromActiveHours(project.decision.pausedRemaining, now);
        project.decision.pausedRemaining = null;
        await this.projectStore.save(project);
      }
    }
    await this.projectStore.setVacation(false);
    return { response: 'Vacation mode OFF. Auto-decide timers resumed.' };
  }

  private async handleAutoDecideExtend(args: string): Promise<HandleResult> {
    const projects = await this.projectStore.loadAll();
    const withDecisions = projects.filter(p => p.decision?.deadline);
    if (withDecisions.length === 0) return { response: 'No projects have pending decisions to extend.' };

    let target: ProjectConfig;
    if (withDecisions.length === 1) {
      target = withDecisions[0];
    } else if (args) {
      const found = withDecisions.find(p => p.slug === args.trim().toLowerCase());
      if (!found) return { response: `Project "${args}" not found or has no pending decision. Options: ${withDecisions.map(p => p.slug).join(', ')}` };
      target = found;
    } else {
      return { response: `Multiple projects have pending decisions. Specify one: ${withDecisions.map(p => `/${p.slug}`).join(', ')}` };
    }

    const WEEK_ACTIVE_HOURS = 84;
    target.decision!.deadline = extendDeadline(target.decision!.deadline, WEEK_ACTIVE_HOURS);
    const dl = formatTimestamp(new Date(target.decision!.deadline));
    await this.projectStore.save(target);
    return { response: `Extended ${target.title} auto-decide to ${dl}` };
  }

  private async handleReset(args: string): Promise<HandleResult> {
    const slug = args.trim().toLowerCase();
    if (!slug) return { response: 'Usage: /reset <project-slug>' };
    const project = await this.projectStore.load(slug);
    if (!project) return { response: `Project "${slug}" not found.` };

    this.sessionManager.resetSession(slug);
    project.sessionId = null;
    project.status = 'Awaiting first message';
    project.decision = null;
    delete (project as Partial<typeof project>).lastConversationAt;
    await this.projectStore.save(project);
    return { response: `Reset session for ${project.title}. Next message will start a fresh conversation.` };
  }

  private handleHelp(): HandleResult {
    const lines = [
      '**muse-bridge commands**',
      '',
      '**Projects**',
      '`/<slug> <message>`: send a message to a project\'s Muse session',
      '`/list`: all projects with status and pending decision',
      '`/details [slug]`: full details (optional: one project)',
      '`/register <slug> <absolute-directory> [title]`: register a project',
      '`/reset <slug>`: wipe the session and start fresh',
      '`/nudge <slug>`: answer the pending decision now (auto-decide)',
      '',
      '**Scheduling**',
      '`/vacation`: pause all auto-decide timers',
      '`/unvacation`: resume timers',
      '`/auto-decide-extend [slug]`: extend a deadline by one week of active hours',
      '',
      '**In a message:** `For later: …` / `Continuation: …` queue a task behind a running turn; `Effort: high` sets the reasoning effort.',
    ];
    return { response: lines.join('\n') };
  }

  private async handleNudge(args: string, onMessage?: OnMessage, onToolUse?: OnToolUse, onFinalPrompt?: OnFinalPrompt): Promise<HandleResult> {
    const slug = args.trim().toLowerCase();
    if (!slug) return { response: 'Usage: /nudge <project-slug>' };
    const project = await this.projectStore.load(slug);
    if (!project) return { response: `Project "${slug}" not found.` };
    console.log(`[CommandRouter] ${slug}: manual nudge`);
    const response = await this.autoDecide(project, onMessage, onToolUse, onFinalPrompt);
    return { response, projectSlug: slug };
  }

  private async handleProject(
    project: ProjectConfig,
    args: string,
    onMessage?: OnMessage,
    onToolUse?: OnToolUse,
    onFinalPrompt?: OnFinalPrompt,
  ): Promise<HandleResult & { projectSlug: string }> {
    const slug = project.slug;

    // "For later:" / "Continuation:" while a run is in flight: don't start a query, park the
    // task and ack. It's drained after the current run pauses. `parked: true` tells the
    // client this call never ran a turn.
    const queued = parseQueuedTask(args);
    if (queued && this.inFlight.has(slug)) {
      const q = this.deferredTasks.get(slug) ?? [];
      q.push(queued);
      this.deferredTasks.set(slug, q);
      const depth = q.length > 1 ? ` (${q.length} queued)` : '';
      const label = queued.kind === 'later' ? '⏳ **Held for later**' : '⏳ **Queued as continuation**';
      const notice = `${label}${depth}: will run when the current work pauses:\n> ${queued.task.slice(0, 300)}`;
      return { response: notice, projectSlug: slug, parked: true };
    }

    if (project.decision) {
      project.status = `Operational with user response: ${args.slice(0, 80)} at ${formatTimestamp()}`;
      project.decision = null;
      await this.projectStore.save(project);
    }

    let cleanArgs = args;
    // Nothing in flight: "For later:" is reframed and run now; "Continuation:" runs its bare task.
    if (queued) {
      cleanArgs = queued.kind === 'later' ? FOR_LATER_RESUME_PREFIX + queued.task : queued.task;
    }

    this.inFlight.add(slug);
    project.lastUserMessageAt = new Date().toISOString();
    // A new exchange starts here, and only here. Drain turns below run inside the same try
    // and so accumulate into the same exchange.
    this.exchangeRoundTrips.set(slug, 0);
    this.exchangeStartedAt.set(slug, new Date());
    try {
      let { response } = await this.runTurn(project, cleanArgs, onMessage, onToolUse, onFinalPrompt);

      // Drain tasks parked while this run was in flight, released together in one turn.
      while ((this.deferredTasks.get(slug)?.length ?? 0) > 0) {
        const q = this.deferredTasks.get(slug)!;
        const batch = q.splice(0, q.length);
        this.deferredTasks.delete(slug);
        const multi = batch.length > 1;
        const listNotice = batch.map(t => `> ${t.task.slice(0, 200)}`).join('\n');
        onMessage?.(`♻️ **Resuming ${batch.length} queued task${multi ? 's' : ''}:**\n${listNotice}`);
        const extra = await this.runTurn(project, buildQueuedDrainPrompt(batch), onMessage, onToolUse, onFinalPrompt);
        response += `\n\n${extra.response}`;
      }

      // Everything has settled. If getting here took more than one round-trip, close with a digest.
      const wrapUp = await this.maybeWrapUpExchange(project, onMessage, onToolUse, onFinalPrompt);
      if (wrapUp) response += `\n\n${wrapUp}`;

      return { response, projectSlug: slug };
    } finally {
      this.inFlight.delete(slug);
      this.exchangeRoundTrips.delete(slug);
      this.exchangeStartedAt.delete(slug);
      this.guardTripped.delete(slug);
    }
  }

  /**
   * Close out a multi-round-trip exchange with one digest turn. The result is pinned to
   * rating 10 on purpose: a rating 0 here would drop straight back into the auto-decide loop,
   * so the digest would license exactly the runaway loop it exists to terminate.
   */
  private async maybeWrapUpExchange(
    project: ProjectConfig,
    onMessage?: OnMessage,
    onToolUse?: OnToolUse,
    onFinalPrompt?: OnFinalPrompt,
  ): Promise<string | null> {
    const slug = project.slug;
    const roundTrips = this.exchangeRoundTrips.get(slug) ?? 0;
    if (roundTrips <= WRAPUP_MIN_ROUND_TRIPS) return null;
    if (this.guardTripped.has(slug)) {
      console.log(`[CommandRouter] ${slug}: skipping wrap-up digest (safety guard already ended the turn)`);
      return null;
    }
    if (this.wrappingUp.has(slug)) return null;

    const startedAt = this.exchangeStartedAt.get(slug) ?? new Date();
    const since = formatTimestamp(startedAt);
    const prompt = buildWrapupPrompt(since);

    this.wrappingUp.add(slug);
    try {
      console.log(`[CommandRouter] ${slug}: wrap-up digest after ${roundTrips} round-trips since ${since}`);
      onMessage?.(`🧾 **Wrapping up**: ${roundTrips} round-trips since ${since}.`);
      onFinalPrompt?.(prompt);

      const result = await this.queryCounted(slug, prompt, {
        cwd: project.directory,
        systemPrompt: PROJECT_SYSTEM_PROMPT,
        onMessage,
        onToolUse,
      });

      const displayMessages = displayOf(result);
      const raw = result.messages[result.messages.length - 1] ?? result.text;
      const summary = extractDecision(raw)?.summary?.trim()
        || `Wrapped up ${roundTrips} round-trips since ${since}; next steps above.`;

      const deadline = calculateDeadline(10);
      project.status = `Awaiting decision regarding ${summary}. Wrapped up after ${roundTrips} round-trips at ${formatTimestamp()}.`;
      project.decision = { summary, rating: 10, deadline: deadline.toISOString(), pausedRemaining: null, at: new Date().toISOString() };
      project.lastConversationAt = new Date().toISOString();
      await this.projectStore.save(project);

      const notice = `⏳ **Decision needed (rating 10):** ${safeBacktickWrap(summary)}`;
      onMessage?.(notice);
      return `${displayMessages.join('\n\n')}\n\n${notice}`;
    } finally {
      this.wrappingUp.delete(slug);
    }
  }

  /** Run a single project turn, then drive the auto-decide loop. */
  private async runTurn(
    project: ProjectConfig,
    cleanArgs: string,
    onMessage?: OnMessage,
    onToolUse?: OnToolUse,
    onFinalPrompt?: OnFinalPrompt,
  ): Promise<{ response: string; projectSlug: string }> {
    // Always tell the agent the current wall-clock time, plus how long it has been when
    // ≥1h has passed since the last conversation.
    const nowFormatted = formatTimestamp();
    let timeHint = `\n\n(Current time: ${nowFormatted}.)`;
    if (project.lastConversationAt) {
      const elapsedHours = (Date.now() - new Date(project.lastConversationAt).getTime()) / (1000 * 60 * 60);
      if (elapsedHours >= 1) {
        const elapsedDays = Math.round(elapsedHours / 24);
        const staleness = elapsedHours >= 20
          ? `${elapsedDays} day${elapsedDays !== 1 ? 's' : ''}`
          : `${Math.round(elapsedHours)} hour${Math.round(elapsedHours) !== 1 ? 's' : ''}`;
        timeHint = `\n\n(Current time: ${nowFormatted}. It's been ${staleness} since we last spoke.)`;
      }
    }

    const parsedEffort = parseEffort(cleanArgs);
    const userPrompt = (parsedEffort.text || 'Continue') + timeHint + SUBAGENT_HINT;
    onFinalPrompt?.(userPrompt);
    const result = await this.queryCounted(project.slug, userPrompt, {
      cwd: project.directory,
      systemPrompt: PROJECT_SYSTEM_PROMPT,
      ...(parsedEffort.effort ? { effort: parsedEffort.effort } : {}),
      onMessage,
      onToolUse,
    });

    project.lastConversationAt = new Date().toISOString();
    if (result.sessionId && result.sessionId !== project.sessionId) project.sessionId = result.sessionId;
    await this.projectStore.save(project);

    const displayMessages = displayOf(result);

    // A stall phrase ("All done.") → nudge immediately (unless on vacation).
    const lastRaw = result.messages[result.messages.length - 1] ?? result.text;
    const lastRawMessage = parseJsonResponse(lastRaw)?.tldr?.trim() ?? '';
    const isStalled = STALL_RESPONSES.some(s => lastRawMessage === s);
    let nudgeResult: { text: string; messages: string[]; toolsUsed: string[] } | null = null;
    if (isStalled && !(await this.projectStore.isVacation())) {
      onMessage?.(`⚡ **Nudging:** "${lastRawMessage}"`);
      onFinalPrompt?.(AUTO_DECIDE_PROMPT);
      nudgeResult = await this.queryCounted(project.slug, AUTO_DECIDE_PROMPT, {
        cwd: project.directory,
        systemPrompt: PROJECT_SYSTEM_PROMPT,
        onMessage,
        onToolUse,
      });
      displayMessages.push(...displayOf(nudgeResult));
    }

    let decisionSuffix = '';
    let decisionSource = result.messages[result.messages.length - 1] ?? result.text;
    if (isStalled && nudgeResult) {
      decisionSource = nudgeResult.messages[nudgeResult.messages.length - 1] ?? nudgeResult.text;
    }
    const decision = await this.enforceJsonEnvelope(project, decisionSource, displayMessages, onMessage, onToolUse, onFinalPrompt);

    if (decision) {
      let { summary, rating } = decision;

      // Waiting for anything → never auto-decide.
      const summaryLower = summary.toLowerCase();
      if (summaryLower.includes('waiting for') || summaryLower.includes('waiting on')) {
        console.log(`[CommandRouter] ${project.slug}: bumped rating ${rating}→10 (waiting: "${summary.slice(0, 60)}")`);
        rating = 10;
      }

      // Single message + no tools = no real work, don't auto-decide.
      if (result.messages.length <= 1 && result.toolsUsed.length === 0 && rating < 10) {
        console.log(`[CommandRouter] ${project.slug}: bumped rating ${rating}→10 (single message, no tools)`);
        rating = 10;
      }

      // "Should I commit?" → yes.
      if (summaryLower.includes('should') && summaryLower.includes('commit')) {
        console.log(`[CommandRouter] ${project.slug}: auto-answering commit question with yes`);
        rating = 0;
        summary = 'Yes, commit.';
      }

      // Question-shaped decisions: re-prompt for pros/cons. NO_CONS → auto-yes (rating 0).
      ({ summary, rating } = await this.runProsCons(project, summary, rating, onMessage, onToolUse, onFinalPrompt));

      const hours = ratingToHours(rating);

      if (hours === 0) {
        const MAX_AUTO_DECIDES = 30;
        let autoCount = 0;
        let lastSummary = '';
        let repeatCount = 0;
        const MAX_REPEAT_SUMMARIES = 2;
        // Echo the auto-decide prompt only once, not 30 times across iterations.
        let lastEchoedPrompt: string | null = null;

        while (autoCount < MAX_AUTO_DECIDES) {
          autoCount++;
          onMessage?.(`⚡ **Auto-decided (${autoCount}/${MAX_AUTO_DECIDES}):** \`${summary}\``);

          if (AUTO_DECIDE_PROMPT !== lastEchoedPrompt) {
            onFinalPrompt?.(AUTO_DECIDE_PROMPT);
            lastEchoedPrompt = AUTO_DECIDE_PROMPT;
          }

          const autoResult = await this.queryCounted(project.slug, AUTO_DECIDE_PROMPT, {
            cwd: project.directory,
            systemPrompt: PROJECT_SYSTEM_PROMPT,
            onMessage,
            onToolUse,
          });

          project.status = `Operational with auto-decision on "${summary}" at ${formatTimestamp()}`;
          project.decision = null;
          await this.projectStore.save(project);

          displayMessages.push(...displayOf(autoResult));

          const nextDecision = await this.enforceJsonEnvelope(
            project,
            autoResult.messages[autoResult.messages.length - 1] ?? autoResult.text,
            displayMessages,
            onMessage, onToolUse, onFinalPrompt,
          );

          if (nextDecision) {
            const nextLower = nextDecision.summary.toLowerCase();
            if (nextLower.includes('waiting for') || nextLower.includes('waiting on')) {
              console.log(`[CommandRouter] ${project.slug}: bumped auto-decide rating ${nextDecision.rating}→10 (waiting: "${nextDecision.summary.slice(0, 60)}")`);
              nextDecision.rating = 10;
            }
            if (autoResult.messages.length <= 1 && autoResult.toolsUsed.length === 0 && nextDecision.rating < 10) {
              console.log(`[CommandRouter] ${project.slug}: bumped auto-decide rating ${nextDecision.rating}→10 (single message, no tools)`);
              nextDecision.rating = 10;
            }
            if (nextLower.includes('should') && nextLower.includes('commit')) {
              console.log(`[CommandRouter] ${project.slug}: auto-answering commit question with yes`);
              nextDecision.rating = 0;
              nextDecision.summary = 'Yes, commit.';
            }
            const updated = await this.runProsCons(project, nextDecision.summary, nextDecision.rating, onMessage, onToolUse, onFinalPrompt);
            nextDecision.summary = updated.summary;
            nextDecision.rating = updated.rating;
          }

          if (!nextDecision || nextDecision.recovered || ratingToHours(nextDecision.rating) > 0) {
            // Not rating 0, or the rating-0 decision only came back after a reprompt (session
            // already under strain): break rather than license another lap.
            if (nextDecision) {
              const nextDeadline = calculateDeadline(nextDecision.rating);
              const dl = formatTimestamp(nextDeadline);
              project.status = `Awaiting decision regarding ${nextDecision.summary}.${nextDecision.rating >= 10 ? '' : ` Auto-decides at ${dl}.`}`;
              project.decision = { summary: nextDecision.summary, rating: nextDecision.rating, deadline: nextDeadline.toISOString(), pausedRemaining: null, at: new Date().toISOString() };
              await this.projectStore.save(project);
              const autoDecideText = nextDecision.rating >= 10 ? '' : `, auto-decides at ${dl}`;
              const innerNotice = `⏳ **Decision needed (rating ${nextDecision.rating}):** ${safeBacktickWrap(nextDecision.summary)}${autoDecideText}`;
              decisionSuffix = `\n\n${innerNotice}`;
              onMessage?.(innerNotice);
            }
            break;
          }
          // Rating 0 again: check for spinning (same summary repeating).
          if (nextDecision.summary === lastSummary) {
            repeatCount++;
            if (repeatCount >= MAX_REPEAT_SUMMARIES) {
              onMessage?.(`⏸️ **Stalled:** ${safeBacktickWrap(nextDecision.summary)} repeated ${repeatCount} times; needs human input.`);
              // Rating 1 is deliberate (retry in ~1 active hour); keep the wrap-up digest off it.
              this.guardTripped.add(project.slug);
              const stallDeadline = calculateDeadline(1);
              const dl = formatTimestamp(stallDeadline);
              project.status = `Stalled on "${nextDecision.summary}". Auto-decides at ${dl}.`;
              project.decision = { summary: nextDecision.summary, rating: 1, deadline: stallDeadline.toISOString(), pausedRemaining: null, at: new Date().toISOString() };
              await this.projectStore.save(project);
              break;
            }
          } else {
            repeatCount = 1;
          }
          lastSummary = nextDecision.summary;
          summary = nextDecision.summary;
        }

        if (autoCount >= MAX_AUTO_DECIDES) {
          onMessage?.(`🛑 **Kill switch activated:** ${MAX_AUTO_DECIDES} consecutive auto-decides. Pausing project.`);
          this.guardTripped.add(project.slug);
          project.status = `Paused: kill switch after ${MAX_AUTO_DECIDES} auto-decides at ${formatTimestamp()}`;
          project.decision = null;
          await this.projectStore.save(project);
        }

        project.lastConversationAt = new Date().toISOString();
        await this.projectStore.save(project);
        return { response: displayMessages.join('\n\n') + decisionSuffix, projectSlug: project.slug };
      }

      const deadline = calculateDeadline(rating);
      const dl = formatTimestamp(deadline);
      project.status = `Awaiting decision regarding ${summary}.${rating >= 10 ? '' : ` Auto-decides at ${dl}.`}`;
      project.decision = { summary, rating, deadline: deadline.toISOString(), pausedRemaining: null, at: new Date().toISOString() };
      await this.projectStore.save(project);
      const autoDecideText = rating >= 10 ? '' : `, auto-decides at ${dl}`;
      const decisionNotice = `⏳ **Decision needed (rating ${rating}):** ${safeBacktickWrap(summary)}${autoDecideText}`;
      decisionSuffix = `\n\n${decisionNotice}`;
      onMessage?.(decisionNotice);
    } else {
      project.status = `Operational at ${formatTimestamp()}`;
      await this.projectStore.save(project);
    }

    return { response: displayMessages.join('\n\n') + decisionSuffix, projectSlug: project.slug };
  }

  /** Passthrough so the cron can force-stop a slug's in-flight turn. */
  stopSlug(slug: string): { stopped: boolean; reason: string } {
    return this.sessionManager.stop(slug);
  }

  /** A client turn for this slug is in flight. */
  isBusy(slug: string): boolean {
    return this.inFlight.has(slug);
  }

  /** Answer the pending decision with "make an informed decision for me" (cron or /nudge). */
  async autoDecide(project: ProjectConfig, onMessage?: OnMessage, onToolUse?: OnToolUse, onFinalPrompt?: OnFinalPrompt): Promise<string> {
    onFinalPrompt?.(AUTO_DECIDE_PROMPT);
    const result = await this.queryCounted(project.slug, AUTO_DECIDE_PROMPT, {
      cwd: project.directory,
      systemPrompt: PROJECT_SYSTEM_PROMPT,
      onMessage,
      onToolUse,
    });

    const responseText = stripJson(result.text);
    const decidedSummary = project.decision?.summary ?? 'unknown';
    project.status = `Operational with auto-decision on "${decidedSummary}" at ${formatTimestamp()}`;
    project.decision = null;
    project.lastConversationAt = new Date().toISOString();
    if (result.sessionId) project.sessionId = result.sessionId;
    await this.projectStore.save(project);

    return `⚡ **[${project.title}] Auto-decided:** \`${decidedSummary}\`\n\n${responseText}`;
  }

  /**
   * If the decision summary asks something ('?') and would otherwise defer to the user
   * (rating 1-9), ask for pros/cons. On NO_CONS, return rating 0 so the caller auto-continues;
   * otherwise ask once for a recommendation and prefer its refined decision.
   */
  private async runProsCons(
    project: ProjectConfig,
    summary: string,
    rating: number,
    onMessage?: OnMessage,
    onToolUse?: OnToolUse,
    onFinalPrompt?: OnFinalPrompt,
  ): Promise<{ summary: string; rating: number }> {
    if (!summary.includes('?')) return { summary, rating };
    if (ratingToHours(rating) === 0) return { summary, rating };
    // Rating 10 is the human's call: a NO_CONS here must not turn it into an auto-yes.
    if (rating >= 10) return { summary, rating };

    console.log(`[CommandRouter] ${project.slug}: question-shaped decision, fetching pros/cons for "${summary.slice(0, 60)}"`);
    onMessage?.(`💭 **Pros/Cons** for \`${summary}\``);
    const prosConsPrompt =
      `Re: "${summary}"\n\n` +
      `Why are you asking me? Are there real cons to this approach? If not, your entire response must be the literal token NO_CONS on its own line, nothing else.\n\n` +
      `Before answering, investigate the relevant code/files/config/runtime state. Cons must be grounded in evidence you actually checked. No speculation.\n\n` +
      `If there ARE cons, list pros and cons. Format strictly:\n\n` +
      `PROS:\n- ...\n\n` +
      `CONS:\n- ...\n\n` +
      `Be concise, one short line per item. Do NOT include a JSON decision block in this response.` +
      SUBAGENT_HINT;
    onFinalPrompt?.(prosConsPrompt);
    const prosCons = await this.queryCounted(project.slug, prosConsPrompt, {
      cwd: project.directory,
      systemPrompt: PROJECT_SYSTEM_PROMPT,
      onMessage,
      onToolUse,
    });
    const prosConsText = stripJson(prosCons.text) || prosCons.text;
    if (/^\s*NO_CONS\s*$/m.test(prosConsText)) {
      console.log(`[CommandRouter] ${project.slug}: NO_CONS detected, auto-yes on "${summary.slice(0, 60)}"`);
      return { summary: `Auto-yes (no cons): ${summary}`, rating: 0 };
    }
    console.log(`[CommandRouter] ${project.slug}: cons found, asking "Then what do you suggest?"`);
    const suggestPrompt = `Then what do you suggest?${SUBAGENT_HINT}`;
    onFinalPrompt?.(suggestPrompt);
    const suggestion = await this.queryCounted(project.slug, suggestPrompt, {
      cwd: project.directory,
      systemPrompt: PROJECT_SYSTEM_PROMPT,
      onMessage,
      onToolUse,
    });
    // The suggestion usually ends with a refined decision: prefer it over the stale question.
    const suggestedDecision = extractDecision(suggestion.text);
    if (suggestedDecision) {
      console.log(`[CommandRouter] ${project.slug}: suggestion produced a refined decision, using it`);
      return suggestedDecision;
    }
    return { summary, rating };
  }

  /**
   * Guarantee a JSON envelope was attempted for `decisionSource`: if none parses (and the
   * text isn't NO_CONS / PROS-CONS), reprompt once. A decision recovered that way is flagged
   * `recovered`, and the auto-decide loop treats it as a reason to stop.
   */
  private async enforceJsonEnvelope(
    project: ProjectConfig,
    decisionSource: string,
    displayMessages: string[],
    onMessage?: OnMessage,
    onToolUse?: OnToolUse,
    onFinalPrompt?: OnFinalPrompt,
  ): Promise<{ summary: string; rating: number; recovered?: boolean } | null> {
    const decision = extractDecision(decisionSource);
    if (decision || isJsonEnvelopeExempt(decisionSource)) return decision;

    console.log(`[CommandRouter] ${project.slug}: response had no JSON envelope, reprompting once`);
    onFinalPrompt?.(MISSING_JSON_ENVELOPE_REPROMPT);
    const retry = await this.queryCounted(project.slug, MISSING_JSON_ENVELOPE_REPROMPT, {
      cwd: project.directory,
      systemPrompt: PROJECT_SYSTEM_PROMPT,
      onMessage,
      onToolUse,
    });
    displayMessages.push(...displayOf(retry));

    const retryDecision = extractDecision(retry.messages[retry.messages.length - 1] ?? retry.text);
    if (!retryDecision) {
      console.log(`[CommandRouter] ${project.slug}: still no JSON envelope after reprompt, passing raw text through`);
      return null;
    }
    return { ...retryDecision, recovered: true };
  }

  /** Every model round-trip of an exchange goes through here, so the wrap-up threshold counts in one place. */
  private queryCounted(
    slug: string,
    prompt: string,
    opts: Parameters<SessionManager['query']>[2],
  ): ReturnType<SessionManager['query']> {
    this.exchangeRoundTrips.set(slug, (this.exchangeRoundTrips.get(slug) ?? 0) + 1);
    return this.sessionManager.query(slug, prompt, opts);
  }
}

/** The human-readable parts of a turn (JSON envelopes stripped), in order. */
function displayOf(result: { text: string; messages: string[] }): string[] {
  const out: string[] = [];
  for (const msg of result.messages) {
    const cleaned = stripJson(msg);
    if (cleaned) out.push(cleaned);
  }
  if (out.length === 0) out.push(stripJson(result.text) || result.text);
  return out;
}
