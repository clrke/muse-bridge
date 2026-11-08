import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandRouter } from '../src/command-router.js';
import { ProjectStore } from '../src/project-store.js';
import type { SessionManager, QueryResult } from '../src/session-manager.js';
import type { AskPayload } from '../src/types.js';

function makePayload(slug: string, args = 'do something'): AskPayload {
  return {
    trigger: {
      sender: 'Test',
      query: args,
      type: 'inline',
      replyTo: null,
      originalMessage: `/${slug} ${args}`,
    },
    recentMessages: [],
    repliedToMessage: null,
  };
}

/** Build a QueryResult — use toolsUsed to allow auto-decide (single msg + no tools → rating 10) */
function makeQueryResult(message: string, rating: number, summary: string, toolsUsed: string[] = []): QueryResult {
  const json = JSON.stringify({ tldr: message, decision: { summary, rating } });
  return {
    text: json,
    messages: [json],
    toolsUsed,
    sessionId: 'test-session',
  };
}

/** Shortcut: result with tools (allows auto-decide) */
function makeWorkResult(message: string, rating: number, summary: string): QueryResult {
  return makeQueryResult(message, rating, summary, ['Read', 'Edit']);
}

/** Stub SessionManager with no-op methods — use when session queries aren't under test */
function makeNoopSM(): SessionManager {
  return {
    query: vi.fn(),
    resetSession: vi.fn(),
    loadSession: vi.fn(),
    getSessionId: vi.fn(),
  } as unknown as SessionManager;
}

/** Stub SessionManager with a custom query implementation */
function makeSmWithQuery(queryImpl: SessionManager['query']): SessionManager {
  return {
    query: vi.fn(queryImpl),
    resetSession: vi.fn(),
    loadSession: vi.fn(),
    getSessionId: vi.fn().mockReturnValue(undefined),
      } as unknown as SessionManager;
}

/** Build a payload for a global command (no args, query: null) */
function makeCommand(command: string): AskPayload {
  return {
    trigger: { type: 'inline', query: null, sender: 'Test', replyTo: null, originalMessage: `/${command}` },
    recentMessages: [],
    repliedToMessage: null,
  };
}

describe('Auto-decide nudge', () => {
  let tmpDir: string;
  let projectStore: ProjectStore;
  let sessionManager: SessionManager;
  let queryCalls: string[];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-decide-'));
    await fs.writeFile(path.join(tmpDir, 'prompt.md'), 'test prompt');
    projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
    await projectStore.init();

    await projectStore.create({
      title: 'Test Project',
      slug: 'test',
      description: 'test',
      directory: tmpDir,
      autoDecide: true,
    });

    queryCalls = [];
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  function mockSessionManager(responses: QueryResult[]): SessionManager {
    let callIndex = 0;
    return {
      query: vi.fn(async (slug: string, prompt: string) => {
        queryCalls.push(prompt);
        return responses[Math.min(callIndex++, responses.length - 1)];
      }),
      resetSession: vi.fn(),
      loadSession: vi.fn(),
      getSessionId: vi.fn().mockReturnValue('test-session'),
          } as unknown as SessionManager;
  }

  it('bumps rating to 10 when initial response is single message with no tools', async () => {
    sessionManager = mockSessionManager([
      makeQueryResult('Just chatting', 0, 'continue'),
    ]);

    const router = new CommandRouter(sessionManager, projectStore);
    const { response } = await router.handle(makePayload('test'));

    // Should NOT auto-decide — rating bumped to 10
    const project = await projectStore.load('test');
    expect(project!.decision).not.toBeNull();
    expect(project!.decision!.rating).toBe(10);
    // Only 1 query call (no auto-decide loop)
    expect(queryCalls).toHaveLength(1);
  });

  it('forwards onApproval from handle through to session queries', async () => {
    const seen: unknown[] = [];
    sessionManager = {
      query: vi.fn(async (slug: string, prompt: string, opts: { onApproval?: unknown }) => {
        queryCalls.push(prompt);
        seen.push(opts?.onApproval);
        return makeWorkResult('Did real work', 0, 'continue');
      }),
      resetSession: vi.fn(),
      loadSession: vi.fn(),
      getSessionId: vi.fn().mockReturnValue('test-session'),
    } as unknown as SessionManager;

    const router = new CommandRouter(sessionManager, projectStore);
    const onApproval = vi.fn();
    await router.handle(makePayload('test'), undefined, undefined, undefined, onApproval);

    expect(queryCalls.length).toBeGreaterThan(0);
    expect(seen.length).toBe(queryCalls.length);
    for (const cb of seen) expect(cb).toBe(onApproval);
  });

  it('allows auto-decide when initial response used tools', async () => {
    sessionManager = mockSessionManager([
      makeWorkResult('Did real work', 0, 'continue'),
      makeWorkResult('More work', 5, 'review'),
    ]);

    const router = new CommandRouter(sessionManager, projectStore);
    await router.handle(makePayload('test'));

    // Should enter auto-decide loop (2 query calls)
    expect(queryCalls.length).toBeGreaterThan(1);
  });

  it('uses normal prompt when initial response used tools', async () => {
    sessionManager = mockSessionManager([
      makeWorkResult('Did real work', 0, 'continue'),
      makeWorkResult('Done', 5, 'review'),
    ]);

    const router = new CommandRouter(sessionManager, projectStore);
    await router.handle(makePayload('test'));

    // Initial had tools → streak=0 → normal prompt
    expect(queryCalls[1]).toContain('Make an informed decision for me');
  });

  it('bumps to 10 inside auto-decide loop when response has no tools', async () => {
    sessionManager = mockSessionManager([
      makeWorkResult('Work done', 0, 'next step'),
      makeQueryResult('Just chatting', 0, 'continue'), // no tools → rating 10
    ]);

    const router = new CommandRouter(sessionManager, projectStore);
    await router.handle(makePayload('test'));

    const project = await projectStore.load('test');
    expect(project!.decision).not.toBeNull();
    expect(project!.decision!.rating).toBe(10);
  });

  it('resets streak when the agent uses tools', async () => {
    sessionManager = mockSessionManager([
      makeWorkResult('Start', 0, 'step 1'),
      makeWorkResult('Step 1', 0, 'step 2'),
      makeWorkResult('Done', 5, 'review'),
    ]);

    const router = new CommandRouter(sessionManager, projectStore);
    await router.handle(makePayload('test'));

    // All had tools → normal prompt throughout
    expect(queryCalls[1]).toContain('Make an informed decision for me');
    expect(queryCalls[2]).toContain('Make an informed decision for me');
  });

  it('breaks out of loop when same summary repeats 2 times', async () => {
    sessionManager = mockSessionManager([
      makeWorkResult('Start', 0, 'same thing'),
      makeWorkResult('Again', 0, 'same thing'),
      makeWorkResult('Again', 0, 'same thing'),
    ]);

    const onMessageTexts: string[] = [];
    const router = new CommandRouter(sessionManager, projectStore);
    await router.handle(makePayload('test'), (text) => onMessageTexts.push(text));

    expect(onMessageTexts.some(t => t.includes('Stalled'))).toBe(true);

    const project = await projectStore.load('test');
    expect(project!.decision).not.toBeNull();
    expect(project!.decision!.rating).toBe(1);
  });

  it('auto-decide notices are NOT in displayMessages (no double-send)', async () => {
    sessionManager = mockSessionManager([
      makeWorkResult('Work done', 0, 'continue'),
      makeWorkResult('More work', 5, 'review'),
    ]);

    const onMessageTexts: string[] = [];
    const router = new CommandRouter(sessionManager, projectStore);
    const { response } = await router.handle(
      makePayload('test'),
      (text) => onMessageTexts.push(text),
    );

    expect(onMessageTexts.some(t => t.includes('⚡ **Auto-decided'))).toBe(true);
    expect(response).not.toContain('⚡ **Auto-decided');
  });

  it('kill switch notice is NOT in displayMessages', async () => {
    const responses = Array.from({ length: 31 }, (_, i) =>
      makeWorkResult(`Step ${i}`, 0, `task ${i}`)
    );
    sessionManager = mockSessionManager(responses);

    const onMessageTexts: string[] = [];
    const router = new CommandRouter(sessionManager, projectStore);
    const { response } = await router.handle(
      makePayload('test'),
      (text) => onMessageTexts.push(text),
    );

    expect(onMessageTexts.some(t => t.includes('🛑 **Kill switch'))).toBe(true);
    expect(response).not.toContain('🛑 **Kill switch');
  });

  it('kill switch pauses project and clears decision', async () => {
    const responses = Array.from({ length: 31 }, (_, i) =>
      makeWorkResult(`Step ${i}`, 0, `task ${i}`)
    );
    sessionManager = mockSessionManager(responses);

    const router = new CommandRouter(sessionManager, projectStore);
    await router.handle(makePayload('test'));

    const project = await projectStore.load('test');
    expect(project!.status).toMatch(/^Paused: kill switch after 30/);
    expect(project!.decision).toBeNull();
    // The wrap-up digest must stand down here — resurrecting a rating-10 decision on a
    // project the kill switch just paused would silently disable the kill switch.
    expect(queryCalls.some(p => p.includes('Summarize what has been done since'))).toBe(false);
  });

  it('does not fire the wrap-up digest on a one-shot exchange', async () => {
    sessionManager = mockSessionManager([
      makeWorkResult('Did the thing', 5, 'review it'),
    ]);

    const router = new CommandRouter(sessionManager, projectStore);
    await router.handle(makePayload('test'));

    // One round-trip is not "more than one" — nothing to summarize.
    expect(queryCalls).toHaveLength(1);
    const project = await projectStore.load('test');
    expect(project!.decision!.rating).toBe(5);
  });

  it('closes a multi-round-trip exchange with a rating-10 wrap-up digest', async () => {
    sessionManager = mockSessionManager([
      makeWorkResult('Starting', 0, 'keep going'),          // rating 0 → auto-decide loop
      makeWorkResult('Done working', 5, 'review it'),        // rating 5 → loop breaks
      makeWorkResult('Here is the summary', 3, 'pick one'),  // the digest reply
    ]);

    const onMessageTexts: string[] = [];
    const router = new CommandRouter(sessionManager, projectStore);
    await router.handle(makePayload('test'), (text) => onMessageTexts.push(text));

    const wrapPrompt = queryCalls[queryCalls.length - 1];
    expect(wrapPrompt).toContain('Summarize what has been done since');
    expect(wrapPrompt).toContain('enumerate next steps');
    expect(wrapPrompt).toContain('rating 10');
    expect(onMessageTexts.some(t => t.includes('Wrapping up'))).toBe(true);

    // Pinned to 10 even though the digest reply itself claimed rating 3 — otherwise a
    // rating 0 here would drop straight back into the auto-decide loop it just ended.
    const project = await projectStore.load('test');
    expect(project!.decision!.rating).toBe(10);
  });

  it('stands down when the stall guard already ended the turn', async () => {
    sessionManager = mockSessionManager([
      makeWorkResult('lap 1', 0, 'same task'),
      makeWorkResult('lap 2', 0, 'same task'),
      makeWorkResult('lap 3', 0, 'same task'),
    ]);

    const router = new CommandRouter(sessionManager, projectStore);
    await router.handle(makePayload('test'));

    expect(queryCalls.some(p => p.includes('Summarize what has been done since'))).toBe(false);
    // The guard's rating 1 (retry in ~1 active hour) must survive; a digest bumping it
    // to 10 would mean a stalled project never retries at all.
    const project = await projectStore.load('test');
    expect(project!.decision!.rating).toBe(1);
  });

  it('stall notice is NOT in displayMessages', async () => {
    sessionManager = mockSessionManager([
      makeWorkResult('Start', 0, 'same thing'),
      makeWorkResult('Again', 0, 'same thing'),
      makeWorkResult('Again', 0, 'same thing'),
    ]);

    const onMessageTexts: string[] = [];
    const router = new CommandRouter(sessionManager, projectStore);
    const { response } = await router.handle(
      makePayload('test'),
      (text) => onMessageTexts.push(text),
    );

    expect(onMessageTexts.some(t => t.includes('⏸️ **Stalled'))).toBe(true);
    expect(response).not.toContain('⏸️ **Stalled');
  });

  it('bumps rating 10 when summary contains "waiting for"', async () => {
    sessionManager = mockSessionManager([
      makeWorkResult('Need input', 3, 'waiting for chlorine reading'),
    ]);

    const router = new CommandRouter(sessionManager, projectStore);
    await router.handle(makePayload('test'));

    const project = await projectStore.load('test');
    expect(project!.decision!.rating).toBe(10);
  });

  it('bumps rating 10 when summary contains "waiting on"', async () => {
    sessionManager = mockSessionManager([
      makeWorkResult('Need input', 2, 'waiting on user input'),
    ]);

    const router = new CommandRouter(sessionManager, projectStore);
    await router.handle(makePayload('test'));

    const project = await projectStore.load('test');
    expect(project!.decision!.rating).toBe(10);
  });

  it('auto-commits when summary contains "should" + "commit"', async () => {
    sessionManager = mockSessionManager([
      makeWorkResult('Changes ready', 3, 'should I commit these changes?'),
      makeWorkResult('Committed', 5, 'review results'),
    ]);

    const router = new CommandRouter(sessionManager, projectStore);
    await router.handle(makePayload('test'));

    // Should have auto-decided with "Yes, commit."
    expect(queryCalls[1]).toContain('Make an informed decision for me');
  });

  it('nudges immediately when the agent returns a stall phrase like "All tasks complete."', async () => {
    const stallResponse: QueryResult = {
      text: JSON.stringify({ tldr: 'All tasks complete.', decision: { summary: 'done', rating: 5 } }),
      messages: [JSON.stringify({ tldr: 'All tasks complete.', decision: { summary: 'done', rating: 5 } })],
      toolsUsed: ['Read'],
      sessionId: 'test-session',
    };
    sessionManager = mockSessionManager([
      stallResponse,
      makeWorkResult('Found new tasks', 5, 'review'),
    ]);

    const onMessageTexts: string[] = [];
    const router = new CommandRouter(sessionManager, projectStore);
    await router.handle(makePayload('test'), (text) => onMessageTexts.push(text));

    // Should send nudge notice
    expect(onMessageTexts.some(t => t.includes('Nudging'))).toBe(true);
    // Should issue a second query with the nudge prompt
    expect(queryCalls[1]).toContain('Make an informed decision for me');
    // Primary + nudge = 2 round-trips, which is more than one, so the exchange closes
    // with a third query: the wrap-up digest.
    expect(queryCalls).toHaveLength(3);
    expect(queryCalls[2]).toContain('Summarize what has been done since');
    expect(queryCalls[2]).toContain('rating 10');
  });

  it('skips nudge on stall when vacation mode is active', async () => {
    const stallResponse: QueryResult = {
      text: JSON.stringify({ tldr: 'All tasks complete.', decision: { summary: 'done', rating: 5 } }),
      messages: [JSON.stringify({ tldr: 'All tasks complete.', decision: { summary: 'done', rating: 5 } })],
      toolsUsed: ['Read'],
      sessionId: 'test-session',
    };
    sessionManager = mockSessionManager([stallResponse]);

    await projectStore.setVacation(true);
    const onMessageTexts: string[] = [];
    const router = new CommandRouter(sessionManager, projectStore);
    await router.handle(makePayload('test'), (text) => onMessageTexts.push(text));

    // Should NOT nudge on vacation
    expect(onMessageTexts.some(t => t.includes('Nudging'))).toBe(false);
    expect(queryCalls).toHaveLength(1);
    await projectStore.setVacation(false);
  });

  it('cron autoDecide uses the standard prompt', async () => {
    const project = await projectStore.load('test');
    project!.decision = { summary: 'pending task', rating: 3, deadline: new Date().toISOString(), pausedRemaining: null };
    await projectStore.save(project!);

    sessionManager = mockSessionManager([makeWorkResult('Auto-decided the thing', 5, 'next step')]);
    const router = new CommandRouter(sessionManager, projectStore);
    await router.autoDecide(project!);

    expect(queryCalls[0]).toContain('Make an informed decision for me');
  });

  it('work prompts carry the subagent hint and no model names', async () => {
    const project = await projectStore.load('test');
    project!.decision = { summary: 'pending task', rating: 3, deadline: new Date().toISOString(), pausedRemaining: null };
    await projectStore.save(project!);

    sessionManager = mockSessionManager([makeWorkResult('Done', 5, 'next step')]);
    const router = new CommandRouter(sessionManager, projectStore);
    await router.autoDecide(project!);

    expect(queryCalls[0]).toContain('Make an informed decision for me');
    expect(queryCalls[0]).toContain('Use subagents');
    expect(queryCalls[0]).not.toMatch(/model/i);
  });

  it('sends `/<slug> <text>` straight to the project session (a leading "Muse:" is just text)', async () => {
    const calls: { slug: string; prompt: string }[] = [];
    sessionManager = {
      query: vi.fn(async (slug: string, prompt: string) => { calls.push({ slug, prompt }); return makeWorkResult('Done', 10, 'Approve it?'); }),
      resetSession: vi.fn(), loadSession: vi.fn(), getSessionId: vi.fn(),
    } as unknown as SessionManager;
    const router = new CommandRouter(sessionManager, projectStore);
    await router.handle(makePayload('test', 'add a jump button'));
    await router.handle(makePayload('test', 'Muse: add a jump button'));
    expect(calls[0].slug).toBe('test');
    expect(calls[0].prompt.startsWith('add a jump button\n\n(Current time:')).toBe(true);
    expect(calls[1].prompt.startsWith('Muse: add a jump button')).toBe(true);
  });

  it('autoDecide clears decision and updates project status', async () => {
    const project = await projectStore.load('test');
    project!.decision = { summary: 'pending task', rating: 3, deadline: new Date().toISOString(), pausedRemaining: null };
    await projectStore.save(project!);

    sessionManager = mockSessionManager([makeWorkResult('Done', 5, 'next step')]);
    const router = new CommandRouter(sessionManager, projectStore);
    const result = await router.autoDecide(project!);

    const saved = await projectStore.load('test');
    expect(saved!.decision).toBeNull();
    expect(saved!.status).toContain('auto-decision on "pending task"');
    expect(result).toContain('⚡');
    expect(result).toContain('pending task');
  });

  it('autoDecide updates lastConversationAt so staleness hint resets', async () => {
    const project = await projectStore.load('test');
    const staleDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    project!.lastConversationAt = staleDate;
    project!.decision = { summary: 'task', rating: 3, deadline: new Date().toISOString(), pausedRemaining: null };
    await projectStore.save(project!);

    sessionManager = mockSessionManager([makeWorkResult('Done', 5, 'next step')]);
    const router = new CommandRouter(sessionManager, projectStore);
    await router.autoDecide(project!);

    const saved = await projectStore.load('test');
    const updatedAt = new Date(saved!.lastConversationAt!).getTime();
    expect(updatedAt).toBeGreaterThan(new Date(staleDate).getTime());
    // Should be within the last 5 seconds
    expect(Date.now() - updatedAt).toBeLessThan(5000);
  });

  describe('staleness hint', () => {
    it('appends hours hint when project was idle for 2 hours', async () => {
      const project = await projectStore.load('test');
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      project!.lastConversationAt = twoHoursAgo;
      await projectStore.save(project!);

      sessionManager = mockSessionManager([makeWorkResult('Done', 5, 'review')]);
      const router = new CommandRouter(sessionManager, projectStore);
      await router.handle(makePayload('test', 'check status'));

      expect(queryCalls[0]).toContain("It's been 2 hours since we last spoke.");
    });

    it('appends days hint when project was idle for 25 hours', async () => {
      const project = await projectStore.load('test');
      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      project!.lastConversationAt = twentyFiveHoursAgo;
      await projectStore.save(project!);

      sessionManager = mockSessionManager([makeWorkResult('Done', 5, 'review')]);
      const router = new CommandRouter(sessionManager, projectStore);
      await router.handle(makePayload('test', 'check status'));

      expect(queryCalls[0]).toContain("It's been 1 day since we last spoke.");
    });

    it('omits hint when project was idle for only 30 minutes', async () => {
      const project = await projectStore.load('test');
      const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      project!.lastConversationAt = thirtyMinsAgo;
      await projectStore.save(project!);

      sessionManager = mockSessionManager([makeWorkResult('Done', 5, 'review')]);
      const router = new CommandRouter(sessionManager, projectStore);
      await router.handle(makePayload('test', 'check status'));

      expect(queryCalls[0]).not.toContain("since we last spoke");
    });

    it('omits hint when lastConversationAt is not set', async () => {
      sessionManager = mockSessionManager([makeWorkResult('Done', 5, 'review')]);
      const router = new CommandRouter(sessionManager, projectStore);
      await router.handle(makePayload('test', 'check status'));

      expect(queryCalls[0]).not.toContain("since we last spoke");
    });
  });
});

describe('Vacation mode', () => {
  let tmpDir: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vacation-'));
    await fs.writeFile(path.join(tmpDir, 'prompt.md'), 'test prompt');
    projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
    await projectStore.init();
    await projectStore.create({ title: 'Alpha', slug: 'alpha', description: 'a', directory: tmpDir, autoDecide: true });
    await projectStore.create({ title: 'Beta', slug: 'beta', description: 'b', directory: tmpDir, autoDecide: true });
  });

  afterEach(async () => { await fs.rm(tmpDir, { recursive: true }); });

  function makeRouter() {
    const sm = makeNoopSM();
    return new CommandRouter(sm, projectStore);
  }

  it('pauses auto-decide deadlines on vacation', async () => {
    const alpha = await projectStore.load('alpha');
    alpha!.decision = { summary: 'pending', rating: 5, deadline: new Date(Date.now() + 36 * 3600_000).toISOString(), pausedRemaining: null };
    await projectStore.save(alpha!);

    const router = makeRouter();
    const { response } = await router.handle(makeCommand('vacation'));
    expect(response).toContain('Vacation mode ON');

    const saved = await projectStore.load('alpha');
    expect(saved!.decision!.deadline).toBe('');
    expect(saved!.decision!.pausedRemaining).toBeGreaterThan(0);
  });

  it('returns early if already on vacation', async () => {
    const router = makeRouter();
    await router.handle(makeCommand('vacation'));
    const { response } = await router.handle(makeCommand('vacation'));
    expect(response).toContain('Already on vacation');
  });

  it('restores deadlines on unvacation', async () => {
    const alpha = await projectStore.load('alpha');
    alpha!.decision = { summary: 'pending', rating: 3, deadline: new Date(Date.now() + 5 * 3600_000).toISOString(), pausedRemaining: null };
    await projectStore.save(alpha!);

    const router = makeRouter();
    await router.handle(makeCommand('vacation'));
    await router.handle(makeCommand('unvacation'));

    const restored = await projectStore.load('alpha');
    expect(restored!.decision!.deadline).not.toBe('');
    expect(restored!.decision!.pausedRemaining).toBeNull();
  });

  it('returns early if not on vacation', async () => {
    const router = makeRouter();
    const { response } = await router.handle(makeCommand('unvacation'));
    expect(response).toContain('Not in vacation mode');
  });
});

describe('Register', () => {
  let tmpDir: string;
  let projectStore: ProjectStore;
  let router: CommandRouter;
  const reg = (args: string) => router.handle({ trigger: { type: 'inline', query: args, sender: 'Test', replyTo: null, originalMessage: `/register ${args}`.trim() }, recentMessages: [], repliedToMessage: null });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'register-'));
    projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
    await projectStore.init();
    router = new CommandRouter(makeNoopSM(), projectStore);
  });

  afterEach(async () => { await fs.rm(tmpDir, { recursive: true }); });

  it('creates a project from slug + absolute directory + title, without a model turn', async () => {
    const { response } = await reg(`testproj ${tmpDir} My Test Project`);
    expect(response).toContain('Project registered!');
    expect(response).toContain('/testproj');
    const project = await projectStore.load('testproj');
    expect(project).toMatchObject({ title: 'My Test Project', directory: tmpDir, autoDecide: false, sessionId: null });
  });

  it('accepts a quoted directory with spaces and defaults the title to the slug', async () => {
    const dir = path.join(tmpDir, 'with space');
    await fs.mkdir(dir);
    await reg(`spaced "${dir}"`);
    expect(await projectStore.load('spaced')).toMatchObject({ title: 'spaced', directory: dir });
  });

  it('rejects bad input', async () => {
    expect((await reg('')).response).toContain('Usage: /register');
    expect((await reg(`Bad_Slug ${tmpDir}`)).response).toContain('Invalid slug');
    expect((await reg(`list ${tmpDir}`)).response).toContain('bridge command');
    expect((await reg('rel relative/dir')).response).toContain('absolute path');
    expect((await reg(`gone ${path.join(tmpDir, 'missing')}`)).response).toContain('not found');
    await reg(`dup ${tmpDir}`);
    expect((await reg(`dup ${tmpDir}`)).response).toContain('already exists');
  });
});

describe('handleList', () => {
  let tmpDir: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'list-'));
    await fs.writeFile(path.join(tmpDir, 'prompt.md'), '');
    projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
    await projectStore.init();
  });

  afterEach(async () => { await fs.rm(tmpDir, { recursive: true }); });

  function makeRouter() {
    const sm = makeNoopSM();
    return new CommandRouter(sm, projectStore);
  }

  it('returns no-projects message when empty', async () => {
    const { response } = await makeRouter().handle(makeCommand('list'));
    expect(response).toContain('No projects registered');
  });

  it('lists all projects with status', async () => {
    await projectStore.create({ title: 'Alpha', slug: 'alpha', description: 'a', directory: tmpDir, autoDecide: true });
    await projectStore.create({ title: 'Beta', slug: 'beta', description: 'b', directory: tmpDir, autoDecide: false });
    const { response } = await makeRouter().handle(makeCommand('list'));
    expect(response).toContain('Alpha');
    expect(response).toContain('Beta');
  });

  it('shows ⏳ decision summary with countdown for auto-decidable ratings', async () => {
    const proj = await projectStore.create({ title: 'Test', slug: 'test', description: 'x', directory: tmpDir, autoDecide: true });
    proj.decision = {
      summary: 'pick a framework',
      rating: 5,
      deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString(), // 3h from now
      pausedRemaining: null,
    };
    await projectStore.save(proj);
    const { response } = await makeRouter().handle(makeCommand('list'));
    expect(response).toContain('⏳');
    expect(response).toContain('pick a framework');
    expect(response).toMatch(/in \d+h/); // countdown
  });

  it('shows "waiting for you" for rating-10 decisions (no auto-decide)', async () => {
    const proj = await projectStore.create({ title: 'Test', slug: 'test', description: 'x', directory: tmpDir, autoDecide: true });
    proj.decision = {
      summary: 'critical decision',
      rating: 10,
      deadline: '9999-12-31T23:59:59Z',
      pausedRemaining: null,
    };
    await projectStore.save(proj);
    const { response } = await makeRouter().handle(makeCommand('list'));
    expect(response).toContain('⏳');
    expect(response).toContain('critical decision');
    expect(response).toContain('waiting for you');
    expect(response).not.toMatch(/in \d+[hmd]/); // no countdown for rating 10
  });
});

describe('handleReset', () => {
  let tmpDir: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reset-'));
    await fs.writeFile(path.join(tmpDir, 'prompt.md'), '');
    projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
    await projectStore.init();
    await projectStore.create({ title: 'Alpha', slug: 'alpha', description: 'a', directory: tmpDir, autoDecide: true });
  });

  afterEach(async () => { await fs.rm(tmpDir, { recursive: true }); });

  it('resets session and clears decision', async () => {
    const alpha = await projectStore.load('alpha');
    alpha!.decision = { summary: 'pending', rating: 3, deadline: new Date().toISOString(), pausedRemaining: null };
    alpha!.sessionId = 'old-session-id';
    await projectStore.save(alpha!);

    const resetSession = vi.fn();
    const sm = { query: vi.fn(), resetSession, loadSession: vi.fn(), getSessionId: vi.fn() } as unknown as SessionManager;
    const router = new CommandRouter(sm, projectStore);
    const { response } = await router.handle({ trigger: { type: 'inline', query: 'alpha', sender: 'Test', replyTo: null, originalMessage: '/reset alpha' }, recentMessages: [], repliedToMessage: null });

    expect(response).toContain('Reset session');
    expect(resetSession).toHaveBeenCalledWith('alpha');
    const saved = await projectStore.load('alpha');
    expect(saved!.decision).toBeNull();
    expect(saved!.sessionId).toBeNull();
  });

  it('returns error for unknown slug', async () => {
    const sm = makeNoopSM();
    const { response } = await new CommandRouter(sm, projectStore).handle({ trigger: { type: 'inline', query: 'nope', sender: 'Test', replyTo: null, originalMessage: '/reset nope' }, recentMessages: [], repliedToMessage: null });
    expect(response).toContain('not found');
  });

  it('returns usage hint when no slug given', async () => {
    const sm = makeNoopSM();
    const { response } = await new CommandRouter(sm, projectStore).handle({ trigger: { type: 'inline', query: '', sender: 'Test', replyTo: null, originalMessage: '/reset' }, recentMessages: [], repliedToMessage: null });
    expect(response).toContain('Usage');
  });
});

describe('handleAutoDecideExtend', () => {
  let tmpDir: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'extend-'));
    await fs.writeFile(path.join(tmpDir, 'prompt.md'), '');
    projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
    await projectStore.init();
  });

  afterEach(async () => { await fs.rm(tmpDir, { recursive: true }); });

  function makeRouter() {
    const sm = makeNoopSM();
    return new CommandRouter(sm, projectStore);
  }

  it('returns no-projects message when none have decisions', async () => {
    await projectStore.create({ title: 'Alpha', slug: 'alpha', description: 'a', directory: tmpDir, autoDecide: true });
    const { response } = await makeRouter().handle(makeCommand('auto-decide-extend'));
    expect(response).toContain('No projects have pending decisions');
  });

  it('extends deadline when exactly one project has a decision', async () => {
    await projectStore.create({ title: 'Alpha', slug: 'alpha', description: 'a', directory: tmpDir, autoDecide: true });
    const alpha = await projectStore.load('alpha');
    const originalDeadline = new Date(Date.now() + 2 * 3600_000).toISOString();
    alpha!.decision = { summary: 'pending', rating: 3, deadline: originalDeadline, pausedRemaining: null };
    await projectStore.save(alpha!);

    const { response } = await makeRouter().handle(makeCommand('auto-decide-extend'));
    expect(response).toContain('Extended Alpha');

    const saved = await projectStore.load('alpha');
    expect(new Date(saved!.decision!.deadline) > new Date(originalDeadline)).toBe(true);
  });

  it('requires slug when multiple projects have decisions', async () => {
    for (const slug of ['alpha', 'beta']) {
      await projectStore.create({ title: slug, slug, description: '', directory: tmpDir, autoDecide: true });
      const p = await projectStore.load(slug);
      p!.decision = { summary: 'pending', rating: 3, deadline: new Date(Date.now() + 3600_000).toISOString(), pausedRemaining: null };
      await projectStore.save(p!);
    }
    const { response } = await makeRouter().handle(makeCommand('auto-decide-extend'));
    expect(response).toContain('Multiple projects');
  });

  it('returns not-found message for invalid slug when multiple projects have decisions', async () => {
    for (const slug of ['alpha', 'beta']) {
      await projectStore.create({ title: slug, slug, description: '', directory: tmpDir, autoDecide: true });
      const p = await projectStore.load(slug);
      p!.decision = { summary: 'pending', rating: 3, deadline: new Date(Date.now() + 3600_000).toISOString(), pausedRemaining: null };
      await projectStore.save(p!);
    }
    const payload: AskPayload = {
      trigger: { type: 'inline', query: 'gamma', sender: 'Test', replyTo: null, originalMessage: '/auto-decide-extend gamma' },
      recentMessages: [], repliedToMessage: null,
    };
    const { response } = await makeRouter().handle(payload);
    expect(response).toContain('not found');
  });
});

describe('handleDetails / handleInfo', () => {
  let tmpDir: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'details-'));
    await fs.writeFile(path.join(tmpDir, 'prompt.md'), '');
    projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
    await projectStore.init();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  function makeRouter() {
    return new CommandRouter(makeNoopSM(), projectStore);
  }

  it('returns "No projects" when none registered', async () => {
    const { response } = await makeRouter().handle(makeCommand('details'));
    expect(response).toContain('No projects registered.');
  });

  it('/info is an alias for /details', async () => {
    const r1 = await makeRouter().handle(makeCommand('details'));
    const r2 = await makeRouter().handle(makeCommand('info'));
    expect(r1.response).toBe(r2.response);
  });

  it('includes project fields in response', async () => {
    await projectStore.create({
      title: 'My Project',
      slug: 'myproj',
      description: 'A test project',
      directory: tmpDir,
      autoDecide: true,
    });

    const { response } = await makeRouter().handle(makeCommand('details'));
    expect(response).toContain('My Project');
    expect(response).toContain('/myproj');
    expect(response).toContain(tmpDir);
    expect(response).toContain('A test project');
  });

  it('includes decision info when project has pending decision', async () => {
    await projectStore.create({ title: 'Decide Me', slug: 'dm', description: '', directory: tmpDir, autoDecide: true });
    const p = await projectStore.load('dm');
    p!.decision = { summary: 'which DB', rating: 7, deadline: new Date(Date.now() + 7200_000).toISOString(), pausedRemaining: null };
    await projectStore.save(p!);

    const { response } = await makeRouter().handle(makeCommand('details'));
    expect(response).toContain('which DB');
    expect(response).toContain('rating: 7');
  });

  it('lists all projects with blank line separator', async () => {
    for (const slug of ['alpha', 'beta']) {
      await projectStore.create({ title: slug, slug, description: '', directory: tmpDir, autoDecide: true });
    }
    const { response } = await makeRouter().handle(makeCommand('details'));
    expect(response).toContain('alpha');
    expect(response).toContain('beta');
    expect(response).toContain('\n\n'); // sections separated by blank line
  });
});

describe('handleProject decision-clearing', () => {
  let tmpDir: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'proj-clear-'));
    await fs.writeFile(path.join(tmpDir, 'prompt.md'), '');
    projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
    await projectStore.init();
    await projectStore.create({ title: 'Test', slug: 'test', description: '', directory: tmpDir, autoDecide: true });
  });

  afterEach(async () => { await fs.rm(tmpDir, { recursive: true }); });

  it('clears decision and updates status when user replies while decision is pending', async () => {
    const project = await projectStore.load('test');
    project!.decision = { summary: 'pick a framework', rating: 7, deadline: new Date(Date.now() + 3600_000).toISOString(), pausedRemaining: null };
    await projectStore.save(project!);

    // Capture intermediate saves to verify the decision-clear save happened
    const savedSnapshots: Array<{ status: string; decision: unknown }> = [];
    const origSave = projectStore.save.bind(projectStore);
    vi.spyOn(projectStore, 'save').mockImplementation(async (p) => {
      savedSnapshots.push({ status: p.status, decision: p.decision });
      return origSave(p);
    });

    const sm: SessionManager = {
      query: vi.fn().mockResolvedValue(makeWorkResult('Done', 5, 'continue')),
      resetSession: vi.fn(),
      loadSession: vi.fn(),
      getSessionId: vi.fn().mockReturnValue('s1'),
          } as unknown as SessionManager;

    const router = new CommandRouter(sm, projectStore);
    await router.handle(makePayload('test', 'use React'));

    // First save should have cleared the decision and set "user response" status
    const clearSave = savedSnapshots.find(s => s.status.includes('user response'));
    expect(clearSave).toBeDefined();
    expect(clearSave!.decision).toBeNull();
    expect(clearSave!.status).toContain('use React');

    vi.restoreAllMocks();
  });

  it('does not mutate status when no decision is pending', async () => {
    const project = await projectStore.load('test');
    project!.status = 'Operational';
    project!.decision = null;
    await projectStore.save(project!);

    const sm: SessionManager = {
      query: vi.fn().mockResolvedValue(makeWorkResult('Done', 0, 'continue')),
      resetSession: vi.fn(),
      loadSession: vi.fn(),
      getSessionId: vi.fn().mockReturnValue('s1'),
          } as unknown as SessionManager;

    const router = new CommandRouter(sm, projectStore);
    await router.handle(makePayload('test', 'continue'));

    const saved = await projectStore.load('test');
    // Status should not say "user response" — no decision was pending
    expect(saved!.status).not.toContain('user response');
  });
});

describe('/help command', () => {
  it('returns a list of all commands without hitting session manager', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'help-'));
    try {
      const store = new ProjectStore(path.join(tmpDir, '.projects'));
      await store.init();
      const router = new CommandRouter(makeNoopSM(), store);
      const { response } = await router.handle(makeCommand('help'));
      expect(response).toContain('/list');
      expect(response).toContain('/nudge');
      expect(response).not.toContain('/compact');
      expect(response).toContain('/reset');
      expect(response).toContain('/vacation');
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

describe('/nudge command', () => {
  let tmpDir: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nudge-'));
    await fs.writeFile(path.join(tmpDir, 'prompt.md'), 'test');
    projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
    await projectStore.init();
    await projectStore.create({ title: 'Test', slug: 'test', description: 'x', directory: tmpDir, autoDecide: true });
  });

  afterEach(async () => { await fs.rm(tmpDir, { recursive: true }); });

  it('returns usage message when no slug given', async () => {
    const router = new CommandRouter(makeNoopSM(), projectStore);
    const { response } = await router.handle(makeCommand('nudge'));
    expect(response).toContain('Usage: /nudge');
  });

  it('returns not-found message for unknown slug', async () => {
    const router = new CommandRouter(makeNoopSM(), projectStore);
    const payload: AskPayload = { trigger: { type: 'inline', query: 'ghost', sender: 'U', replyTo: null, originalMessage: '/nudge ghost' }, recentMessages: [], repliedToMessage: null };
    const { response } = await router.handle(payload);
    expect(response).toContain('"ghost" not found');
  });

  it('calls autoDecide and returns projectSlug for context% footer', async () => {
    const sm: SessionManager = {
      query: vi.fn().mockResolvedValue(makeWorkResult('Did some work', 5, 'review results')),
      resetSession: vi.fn(), loadSession: vi.fn(),
      getSessionId: vi.fn().mockReturnValue('s1'),     } as unknown as SessionManager;
    const router = new CommandRouter(sm, projectStore);
    const payload: AskPayload = { trigger: { type: 'inline', query: 'test', sender: 'U', replyTo: null, originalMessage: '/nudge test' }, recentMessages: [], repliedToMessage: null };
    const result = await router.handle(payload);
    expect(result.projectSlug).toBe('test');
    expect(result.response).toContain('Auto-decided');
  });
});

describe('removed commands', () => {
  it('/compact and /handover are not bridge commands any more (Muse manages its own context)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'removed-'));
    const store = new ProjectStore(path.join(tmpDir, '.projects'));
    await store.init();
    const router = new CommandRouter(makeNoopSM(), store);
    expect((await router.handle(makeCommand('compact'))).response).toBe('Unknown command: /compact');
    expect((await router.handle(makeCommand('handover'))).response).toBe('Unknown command: /handover');
    await fs.rm(tmpDir, { recursive: true });
  });
});

describe('pros/cons never overrides a rating-10 decision', () => {
  it('returns rating 10 untouched without asking for pros/cons', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'proscons-'));
    await fs.writeFile(path.join(tmpDir, 'prompt.md'), 'test prompt');
    const store = new ProjectStore(path.join(tmpDir, '.projects'));
    await store.init();
    await store.create({ title: 'T', slug: 't', description: '', directory: tmpDir, autoDecide: true });
    const sm = makeSmWithQuery(async () => makeQueryResult('NO_CONS', 0, ''));
    const router = new CommandRouter(sm, store);
    const project = (await store.load('t'))!;
    const out = await (router as any).runProsCons(project, 'Approve 1 and 3?', 10);
    expect(out).toEqual({ summary: 'Approve 1 and 3?', rating: 10 });
    expect(sm.query).not.toHaveBeenCalled();
    // Below 10 the pros/cons check still runs.
    await (router as any).runProsCons(project, 'Ship it?', 5);
    expect(sm.query).toHaveBeenCalled();
    await fs.rm(tmpDir, { recursive: true });
  });
});

