/**
 * Translating Muse Code `muse exec --json` tool events into the bridge's client-facing tool
 * vocabulary: Bash/Read/Write/Edit lines (with absolute paths, so a client can pick up
 * generated files), TodoWrite progress, and Agent (subagent) lifecycle. Shapes recorded from
 * Muse Code 1.4.14.
 */
import path from 'node:path';

export interface MuseToolLine { name: string; detail: string }

const IMAGE_PATH_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp)$/i;
const abs = (p: string, cwd: string) => (path.isAbsolute(p) ? p : path.join(cwd, p));
const firstLine = (s: string, max = 200) => s.split('\n')[0].slice(0, max);

function json(text: string): Record<string, any> | null {
  try { const j = JSON.parse(text); return j && typeof j === 'object' ? j : null; } catch { return null; }
}

/**
 * One line for a `tool.result`, or null when it is shown some other way (todos via the todo
 * snapshot, subagents via the Agent events) or carries nothing worth a line.
 * `editPath` is the result's `edit_facts.path` (relative to the workspace).
 */
export function museToolLine(tool: string, text: string, editPath: unknown, cwd: string): MuseToolLine | null {
  if (tool === 'write_todos' || tool.startsWith('subagent_')) return null;
  switch (tool) {
    case 'bash': return { name: 'Bash', detail: json(text)?.command ?? firstLine(text) };
    case 'read_file': {
      const m = text.match(/^Read \w+ file `([^`]+)`/);
      if (m) return { name: 'Read', detail: abs(m[1], cwd) };
      const failed = text.match(/requested absolute path "([^"]+)"/); // "tool failed: No such file…"
      return { name: 'Read', detail: failed ? `${failed[1]} (failed)` : firstLine(text) };
    }
    case 'write_file':
    case 'edit_file': {
      const m = text.match(/ to (\/\S+?)(?:;|$|\s)/);
      const p = m?.[1] ?? (typeof editPath === 'string' ? abs(editPath, cwd) : null);
      return { name: tool === 'write_file' ? 'Write' : 'Edit', detail: p ?? firstLine(text) };
    }
    case 'image_generation': {
      // "Saved generated image to generated_images/<id>.png": a file a client may want to show.
      const m = text.match(/Saved generated image to (\S+)/);
      return { name: 'Write', detail: m ? abs(m[1], cwd) : firstLine(text) };
    }
    case 'web_search': return { name: 'WebSearch', detail: String(json(text)?.query ?? firstLine(text)) };
    case 'web_fetch': return { name: 'WebFetch', detail: String(json(text)?.url ?? firstLine(text)) };
    case 'search': {
      const hits = text.trim() ? text.trim().split('\n').length : 0;
      return { name: 'Grep', detail: `${hits} match line${hits === 1 ? '' : 's'}` };
    }
    case 'bash_input': {
      const j = json(text);
      return { name: 'Bash', detail: String(j?.command ?? j?.input ?? j?.stdin ?? compact(text)) };
    }
    default: {
      if (QUIET_TOOLS.test(tool)) return null; // bookkeeping the user doesn't need a line for
      const label = tool.replace(/^mcp__/, '').replace(/__/g, ':');
      return { name: label, detail: compact(text) };
    }
  }
}

/** Muse's own bookkeeping tools: memory, work/goal tracking, progress reports, skills. */
const QUIET_TOOLS = /^(?:read_memory|add_memory|edit_memory|work_\w+|get_goal|create_goal|update_goal|report_progress|read_skill|cron_\w+)$/;

/** Collapse (possibly pretty-printed JSON) text to one short line: never just "{". */
function compact(text: string, max = 200): string {
  const j = json(text);
  const flat = (j ? JSON.stringify(j) : text).replace(/\s+/g, ' ').trim();
  return flat.slice(0, max);
}

/** True when the path is an image a client may want to display. */
export const isImagePath = (p: string) => IMAGE_PATH_RE.test(p);

/** TodoWrite payload (a client can render it as a progress list), from a `todo.snapshot.updated` event. */
export function museTodoDetail(facts: any): string | null {
  const items: any[] = Array.isArray(facts?.items) ? facts.items : [];
  if (items.length === 0) return null;
  return JSON.stringify({
    todos: items.map(i => ({ content: String(i.text ?? ''), status: String(i.status ?? 'pending'), activeForm: String(i.text ?? '') })),
  });
}

export interface MuseSubagentEvent {
  kind: 'spawned' | 'ended';
  id: string;
  /** spawned: display name from the agent path ("main/counter/1" → "counter"). */
  name?: string;
  /** ended: normalised status (completed / failed / stopped). */
  status?: string;
  /** ended: the subagent's summary. */
  summary?: string;
}

const DONE_STATUS: Record<string, string> = {
  ready: 'completed', completed: 'completed', done: 'completed', finished: 'completed', success: 'completed',
  failed: 'failed', error: 'failed', cancelled: 'stopped', canceled: 'stopped', stopped: 'stopped',
};

/** Subagent lifecycle from a `subagent_*` tool.result; null for anything that isn't one. */
export function museSubagentEvent(tool: string, text: string): MuseSubagentEvent | null {
  if (!tool.startsWith('subagent_')) return null;
  const j = json(text);
  const id = typeof j?.subagent_id === 'string' ? j.subagent_id : null;
  if (!j || !id) return null;
  const status = String(j.status ?? '').toLowerCase();
  if (tool === 'subagent_spawn') {
    if (status !== 'accepted' && status !== 'started' && status !== 'running') return null;
    const seg = typeof j.agent_path === 'string' ? j.agent_path.split('/')[1] : '';
    return { kind: 'spawned', id, name: seg || 'subagent' };
  }
  const mapped = DONE_STATUS[status] ?? (tool === 'subagent_cancel' ? 'stopped' : undefined);
  if (!mapped) return null; // still running / waiting
  return { kind: 'ended', id, status: mapped, summary: typeof j.summary === 'string' ? j.summary : undefined };
}
