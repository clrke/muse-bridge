/**
 * Translating `muse serve` view events into the bridge's client-facing vocabulary.
 *
 * Deliberately thin: a toolCall item's `{tool, visibleOutput}` is the same tool result
 * text `muse exec --json` streams, so tool lines reuse museToolLine verbatim (same
 * Bash/Read/Write/Edit names, same absolute paths, same quiet-tool set), and todo
 * snapshots reuse museTodoDetail. New here: text deltas, turn terminals, subagent
 * items, and the approval summary the `approval` feed event carries.
 * Shapes recorded live from Muse Code 1.4.14 (spike 2026-11-08).
 */
import { museTodoDetail, museToolLine, type MuseToolLine } from './muse-events.js';

/** Streaming text from an `item/delta`; null unless it appends to `text`. */
export function mspTextDelta(params: any): string | null {
  if (typeof params?.delta !== 'string') return null;
  const field = params.field;
  if (field !== undefined && field !== 'text') return null; // "summary.0", "output", ...
  return params.delta;
}

/** Full text of a completed `agentMessage` item; null for anything else. */
export function mspAgentText(item: any): string | null {
  if (item?.kind !== 'agentMessage') return null;
  return typeof item.text === 'string' ? item.text : null;
}

/**
 * One line for a completed `toolCall` item, or null when it is shown some other
 * way (todos, subagents) or carries nothing worth a line. Same contract as the
 * exec path: a failed call still maps (its output holds the error).
 */
export function mspToolLine(item: any, cwd: string): MuseToolLine | null {
  if (item?.kind !== 'toolCall') return null;
  const tool = typeof item.tool === 'string' ? item.tool : '';
  const output = typeof item.visibleOutput === 'string' ? item.visibleOutput : '';
  return museToolLine(tool, output, undefined, cwd);
}

/** TodoWrite payload from a `session/todoListChanged`; null when empty. */
export function mspTodoDetail(items: unknown): string | null {
  return museTodoDetail({ items });
}

export interface MspSubagentLine {
  /** completed / failed / stopped / running (tolerant: unknown statuses pass through). */
  status: string;
  summary?: string;
}

/**
 * Lifecycle of a `subagent` item; null when the item says nothing usable.
 * Member names are read tolerantly — the serve subagent shape is unobserved.
 */
export function mspSubagentLine(item: any): MspSubagentLine | null {
  if (item?.kind !== 'subagent') return null;
  const status = item.status ?? item.state;
  if (typeof status !== 'string' || !status) return null;
  const out: MspSubagentLine = { status: status.toLowerCase() };
  const summary = item.summary ?? item.text;
  if (typeof summary === 'string' && summary) out.summary = summary;
  return out;
}

export interface MspApprovalSummary {
  tool: string;
  /** Human-readable subject: command, path, or kind. */
  subject: string;
  decision: string;
  resolvedBy: string;
  policyResult: string;
  /** One line for narrow clients: `Bash 'pwd' — approved by llmJudge (allow)`. */
  line: string;
}

/**
 * Approval summary from an `approval/resolved`, joined with the earlier
 * `approval/reviewing` when the driver kept it (tool name + raw subject).
 * Emitted once, at resolve time: the feed is append-only, so there is no
 * pending→resolved update — lifecycle streaming would need new feed semantics.
 */
export function mspApprovalSummary(resolved: any, reviewing?: any): MspApprovalSummary | null {
  const decision = resolved?.decision;
  if (typeof decision !== 'string' || !decision) return null;
  const subject = resolved?.subject ?? reviewing?.subject ?? {};
  const tool = String(reviewing?.toolName ?? subject.toolName ?? subject.kind ?? 'tool');
  const raw = reviewing?.rawArgs;
  let parsed: Record<string, any> | null = null;
  if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw);
      parsed = j && typeof j === 'object' ? j : null;
    } catch {
      parsed = null;
    }
  } else if (raw && typeof raw === 'object') {
    parsed = raw;
  }
  const subj =
    typeof parsed?.command === 'string' ? parsed.command
    : typeof subject.command === 'string' ? subject.command
    : typeof subject.path === 'string' ? subject.path
    : typeof subject.target === 'string' ? subject.target
    : typeof subject.kind === 'string' ? subject.kind
    : 'action';
  const resolvedBy = String(resolved?.resolvedBy ?? 'unknown');
  const policyResult = String(resolved?.policyResult ?? 'unknown');
  const label = tool === 'bash' ? 'Bash' : tool;
  return {
    tool,
    subject: subj,
    decision,
    resolvedBy,
    policyResult,
    line: `${label} '${subj.slice(0, 120)}' — ${decision} by ${resolvedBy} (${policyResult})`,
  };
}

/**
 * A `turn/completed` terminal folded to the bridge's three outcomes.
 * Unknown terminals fail closed: never reported as a quiet success.
 */
export function mspTurnTerminal(params: any): 'completed' | 'failed' | 'cancelled' {
  const t = params?.terminal;
  if (t === 'completed' || t === 'cancelled') return t;
  return 'failed';
}
