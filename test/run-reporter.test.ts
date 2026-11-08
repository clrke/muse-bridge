import { describe, it, expect, vi } from 'vitest';
import { Feed } from '../src/feed.js';
import { RunReporter } from '../src/run-reporter.js';

const approval = {
  tool: 'bash',
  subject: 'pwd',
  decision: 'approved',
  resolvedBy: 'llmJudge',
  policyResult: 'allow',
  line: "Bash 'pwd' — approved by llmJudge (allow)",
};

describe('RunReporter.onApproval', () => {
  it('fans out to sink and feed with slug and runId', () => {
    const feed = new Feed();
    const sink = vi.fn();
    const run = new RunReporter({ runId: 'r1', slug: 'bots', feed, source: 'agents', sink });
    run.start();
    run.onApproval(approval);

    expect(sink).toHaveBeenCalledWith({ type: 'approval', ...approval });
    const evs = feed.since(0).filter((e) => e.type === 'approval');
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ slug: 'bots', runId: 'r1', type: 'approval', ...approval });
  });

  it('drops approvals after the run ends, like other callbacks', () => {
    const feed = new Feed();
    const sink = vi.fn();
    const run = new RunReporter({ runId: 'r1', slug: 'bots', feed, source: 'agents', sink });
    run.start();
    run.finish('{"tldr":"x","decision":"y","rating":0}');
    run.onApproval(approval);

    expect(sink.mock.calls.some((c) => c[0].type === 'approval')).toBe(false);
    expect(feed.since(0).some((e) => e.type === 'approval')).toBe(false);
  });

  it('still sinks for bridge commands with no feed', () => {
    const sink = vi.fn();
    const run = new RunReporter({ runId: 'r1', slug: null, source: 'ask', sink });
    run.onApproval(approval);
    expect(sink).toHaveBeenCalledWith({ type: 'approval', ...approval });
  });
});
