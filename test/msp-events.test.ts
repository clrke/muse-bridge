import { describe, it, expect } from 'vitest';
import {
  mspAgentText,
  mspApprovalSummary,
  mspSubagentLine,
  mspTextDelta,
  mspTodoDetail,
  mspToolLine,
  mspTurnTerminal,
} from '../src/msp-events.js';

// Shapes recorded live from `muse serve` 1.4.14 (spike 2026-11-08).
const toolCall = (tool: string, visibleOutput: string, extra: object = {}) => ({
  itemId: 'i1', kind: 'toolCall', turnId: 't1', revision: 3, status: 'completed',
  recordedAt: '2026-11-08T01:54:16.138929Z', tool, callId: 'call_1',
  args: JSON.stringify({ command: 'pwd' }), visibleOutput, ...extra,
});
const bashPwd = toolCall('bash', JSON.stringify({
  chunk_id: 'exec-1-1', command: 'pwd', exit_code: 0, terminal_status: 'completed',
  output: '/private/tmp/msp-spike/ws\n', truncated: false,
}));

describe('msp-events', () => {
  it('takes text deltas, ignores other fields and non-text', () => {
    expect(mspTextDelta({ itemId: 'x', field: 'text', delta: 'hi' })).toBe('hi');
    expect(mspTextDelta({ itemId: 'x', delta: 'hi' })).toBe('hi'); // absent means text
    expect(mspTextDelta({ itemId: 'x', field: 'summary.0', delta: 'hi' })).toBeNull();
    expect(mspTextDelta({ itemId: 'x' })).toBeNull();
    expect(mspTextDelta(null)).toBeNull();
  });

  it('reads full text only from agentMessage items', () => {
    expect(mspAgentText({ kind: 'agentMessage', text: 'done' })).toBe('done');
    expect(mspAgentText({ kind: 'userMessage', text: 'do it' })).toBeNull();
    expect(mspAgentText({ kind: 'agentMessage' })).toBeNull();
  });

  it('maps toolCall items to the same lines as the exec path', () => {
    expect(mspToolLine(bashPwd, '/w')).toEqual({ name: 'Bash', detail: 'pwd' });
    expect(mspToolLine(toolCall('read_file', 'Read text file `src/a.ts`.\n1|hi'), '/w'))
      .toEqual({ name: 'Read', detail: '/w/src/a.ts' });
    expect(mspToolLine(toolCall('write_file', 'wrote 3 lines to /w/out.txt; done'), '/w'))
      .toEqual({ name: 'Write', detail: '/w/out.txt' });
    expect(mspToolLine(toolCall('search', 'a\nb\nc'), '/w'))
      .toEqual({ name: 'Grep', detail: '3 match lines' });
  });

  it('stays quiet for todos, subagent calls, and bookkeeping — like exec', () => {
    expect(mspToolLine(toolCall('write_todos', '{}'), '/w')).toBeNull();
    expect(mspToolLine(toolCall('subagent_spawn', '{}'), '/w')).toBeNull();
    expect(mspToolLine(toolCall('read_memory', '{}'), '/w')).toBeNull();
    expect(mspToolLine({ kind: 'agentMessage', text: 'x' }, '/w')).toBeNull();
  });

  it('still maps failed calls (their output holds the error)', () => {
    const failed = toolCall('bash', JSON.stringify({ command: 'nope', exit_code: 127, output: 'not found' }), { status: 'failed' });
    expect(mspToolLine(failed, '/w')).toEqual({ name: 'Bash', detail: 'nope' });
  });

  it('renders todo snapshots in the exec TodoWrite shape', () => {
    const detail = mspTodoDetail([
      { text: 'Spike', status: 'completed' },
      { text: 'Build', status: 'in_progress', activeForm: 'Building' },
    ]);
    // Exec parity: activeForm echoes the text (museTodoDetail ignores the member).
    expect(JSON.parse(detail!)).toEqual({
      todos: [
        { content: 'Spike', status: 'completed', activeForm: 'Spike' },
        { content: 'Build', status: 'in_progress', activeForm: 'Build' },
      ],
    });
    expect(mspTodoDetail([])).toBeNull();
  });

  it('summarizes a resolved approval with tool, subject, and decider', () => {
    const reviewing = {
      approvalId: 'a', toolName: 'bash', toolCallId: 'call_1',
      rawArgs: JSON.stringify({ command: 'pwd', description: 'run pwd command' }),
    };
    const resolved = {
      approvalId: 'a', itemId: 'i', turnId: 't', decision: 'approved',
      resolvedBy: 'llmJudge', policyResult: 'allow', stageEvidence: [],
    };
    expect(mspApprovalSummary(resolved, reviewing)).toEqual({
      tool: 'bash',
      subject: 'pwd',
      decision: 'approved',
      resolvedBy: 'llmJudge',
      policyResult: 'allow',
      line: "Bash 'pwd' — approved by llmJudge (allow)",
    });
  });

  it('summarizes approvals from subject alone when reviewing was not kept', () => {
    const resolved = {
      decision: 'denied', resolvedBy: 'user', policyResult: 'deny',
      subject: { kind: 'write', toolName: 'write_file', path: '/w/x.txt' },
    };
    expect(mspApprovalSummary(resolved)).toMatchObject({
      tool: 'write_file', subject: '/w/x.txt', decision: 'denied',
    });
    expect(mspApprovalSummary({})).toBeNull();
  });

  it('folds turn terminals, failing closed on unknown values', () => {
    expect(mspTurnTerminal({ terminal: 'completed' })).toBe('completed');
    expect(mspTurnTerminal({ terminal: 'cancelled' })).toBe('cancelled');
    expect(mspTurnTerminal({ terminal: 'failed' })).toBe('failed');
    expect(mspTurnTerminal({ terminal: 'exhausted' })).toBe('failed');
    expect(mspTurnTerminal({})).toBe('failed');
  });

  it('reads subagent items tolerantly, null when uninformative', () => {
    expect(mspSubagentLine({ kind: 'subagent', status: 'completed', summary: 'ok' }))
      .toEqual({ status: 'completed', summary: 'ok' });
    expect(mspSubagentLine({ kind: 'subagent', state: 'Running' })).toEqual({ status: 'running' });
    expect(mspSubagentLine({ kind: 'subagent' })).toBeNull();
    expect(mspSubagentLine({ kind: 'toolCall' })).toBeNull();
  });
});
