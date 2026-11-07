import { describe, it, expect } from 'vitest';
import { Feed } from '../src/feed.js';
import { RunReporter, replyDecision } from '../src/run-reporter.js';

describe('Feed', () => {
  it('numbers events globally across slugs and runs, and tracks busy per slug', () => {
    const feed = new Feed();
    feed.startRun('a', 'r1');
    feed.startRun('b', 'r2');
    feed.append('a', 'r1', 'message', { text: 'hi', speech: 'hi', parentId: null });
    expect(feed.isBusy('a')).toBe(true);
    expect(feed.currentRunId('b')).toBe('r2');
    feed.endRun('a', 'r1', 'done', { response: 'x', speech: 'x', decision: null, rating: null });
    const evs = feed.since(0);
    expect(evs.map(e => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(evs.map(e => `${e.slug}:${e.type}`)).toEqual(['a:run', 'a:agent_state', 'b:run', 'b:agent_state', 'a:message', 'a:done', 'a:agent_state']);
    expect(evs[6]).toMatchObject({ busy: false, runId: 'r1' });
    expect(feed.isBusy('a')).toBe(false);
    expect(feed.currentRunId('a')).toBeNull();
    expect(feed.lastSpeech('a')).toBe('x');
  });

  it('stays busy while a queued second run for the same slug is open', () => {
    const feed = new Feed();
    feed.startRun('a', 'r1');
    feed.startRun('a', 'r2');
    feed.endRun('a', 'r1', 'done');
    expect(feed.since(0).at(-1)).toMatchObject({ type: 'agent_state', busy: true, runId: 'r1' });
    expect(feed.currentRunId('a')).toBe('r2');
    feed.endRun('a', 'r2', 'error', { error: 'boom' });
    expect(feed.since(0).at(-1)).toMatchObject({ type: 'agent_state', busy: false });
  });

  it('keeps at most maxEvents, newest first out of the ring', () => {
    const feed = new Feed(60 * 60_000, 5);
    for (let i = 0; i < 12; i++) feed.append('a', 'r', 'tool', { name: 'Bash', detail: String(i) });
    expect(feed.since(0).map(e => e.seq)).toEqual([8, 9, 10, 11, 12]);
    expect(feed.since(10).map(e => e.seq)).toEqual([11, 12]);
  });

  it('drops events older than the retention window', () => {
    let now = 1_000_000;
    const feed = new Feed(60 * 60_000, 5000, () => now);
    feed.append('a', 'r', 'tool', { name: 'x' });
    now += 30 * 60_000;
    feed.append('a', 'r', 'tool', { name: 'y' });
    now += 31 * 60_000;
    expect(feed.since(0).map(e => e.name)).toEqual(['y']);
  });

  it('replays the whole buffer for a cursor from a previous bridge process (after > lastSeq)', () => {
    const feed = new Feed();
    feed.append('a', 'r', 'tool', { name: 'x' });
    feed.append('a', 'r', 'tool', { name: 'y' });
    expect(feed.since(999).map(e => e.seq)).toEqual([1, 2]);
    expect(feed.since(2)).toEqual([]);
  });

  it('only main-session speech counts as lastSpeech', () => {
    const feed = new Feed();
    feed.append('a', 'r', 'message', { text: 'main', speech: 'main', parentId: null });
    feed.append('a', 'r', 'message', { text: 'sub', speech: 'sub', parentId: 'sa-1' });
    feed.append('a', 'r', 'message', { text: '```x```', speech: '', parentId: null });
    expect(feed.lastSpeech('a')).toBe('main');
  });
});

describe('decision parsing', () => {
  it.each([
    ['flat envelope', '{"tldr":"t","other_findings":"","assumptions_made":"","decision":"Ship it?","rating":7}', 'Ship it?', 7],
    ['rating 0', '{"tldr":"t","decision":"continue","rating":0}', 'continue', 0],
    ['fenced JSON', 'Here:\n```json\n{"tldr":"t","decision":"Deploy","rating":3}\n```', 'Deploy', 3],
    ['preamble then JSON', 'Done.\n{"tldr":"t","decision":"Merge","rating":2}', 'Merge', 2],
    ['legacy nested shape', '{"tldr":"t","decision":{"summary":"Old","rating":5}}', 'Old', 5],
    ['tldr only', '{"tldr":"t"}', null, null],
    ['truncated JSON', '{"tldr":"half a sent', null, null],
    ['not JSON', 'Just prose, no envelope.', null, null],
    ['rating not a number', '{"tldr":"t","decision":"x","rating":"high"}', null, null],
  ])('%s', (_name, raw, decision, rating) => {
    expect(replyDecision(raw)).toEqual({ decision, rating });
  });

  it('done carries the last main-session envelope: decision, rating and tldr as speech', () => {
    const feed = new Feed();
    const r = new RunReporter({ runId: 'r1', slug: 'a', feed, source: 'ask' });
    r.start();
    r.onMessage('{"tldr":"First **pass**.","decision":"continue","rating":0}');
    r.onMessage('{"tldr":"sub","decision":"nope","rating":9}', { parentId: 'sa-1' }); // subagent: ignored
    r.onMessage('{"tldr":"Second pass done. See https://x.dev","decision":"Release v2?","rating":6}');
    r.onMessage('⏳ **Decision needed (rating 6):** Release v2?'); // bridge notice, not an envelope
    r.finish('whatever the router returned');
    const done = feed.since(0).find(e => e.type === 'done');
    expect(done).toMatchObject({ response: 'whatever the router returned', speech: 'Second pass done. See', decision: 'Release v2?', rating: 6 });
  });

  it('done without any envelope: null decision/rating and speech from the response', () => {
    const sink: Record<string, unknown>[] = [];
    const r = new RunReporter({ runId: 'r1', slug: null, source: 'ask/stream', sink: (d) => sink.push(d) });
    r.start();
    r.finish('**Project registered!** `/x`');
    expect(sink.at(-1)).toMatchObject({ type: 'done', speech: 'Project registered!', decision: null, rating: null, singleShot: true });
  });

  it('drops callbacks after the run ended', () => {
    const feed = new Feed();
    const r = new RunReporter({ runId: 'r1', slug: 'a', feed, source: 'cron' });
    r.start();
    r.fail(new Error('auto-decide timed out after 60 minutes'));
    r.onMessage('late');
    r.onToolUse('Bash', 'ls');
    r.finish('late');
    expect(feed.since(0).map(e => e.type)).toEqual(['run', 'agent_state', 'error', 'agent_state']);
  });
});
