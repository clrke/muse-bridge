import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mainSessionOnly, runAutoDecidePass, startCronJobs } from '../src/cron.js';
import type { CronDeps } from '../src/cron.js';
import { Feed } from '../src/feed.js';
import type { ProjectStore } from '../src/project-store.js';
import type { CommandRouter } from '../src/command-router.js';
import type { ProjectConfig } from '../src/types.js';

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    title: 'Test',
    slug: 'test',
    description: '',
    directory: '/tmp',
    sessionId: null,
    status: 'active',
    decision: null,
    autoDecide: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<CronDeps> = {}): CronDeps {
  return {
    commandRouter: {
      autoDecide: vi.fn().mockResolvedValue('auto-decided'),
      isBusy: vi.fn().mockReturnValue(false),
      stopSlug: vi.fn().mockReturnValue({ stopped: false, reason: 'no session' }),
    } as unknown as CommandRouter,
    projectStore: {
      loadAll: vi.fn().mockResolvedValue([]),
      load: vi.fn().mockResolvedValue(null),
      isVacation: vi.fn().mockResolvedValue(false),
    } as unknown as ProjectStore,
    config: { autoDecideTimeoutMs: 15 * 60 * 1000 },
    broadcast: vi.fn(),
    ...overrides,
  };
}

describe('Cron', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

describe('auto-decide interval', () => {

  it('calls autoDecide for projects with passed deadline during active hours', async () => {
    // 10AM — active hour
    vi.setSystemTime(new Date('2026-04-07T10:00:00'));

    const project = makeProject({
      decision: { summary: 'pick DB', rating: 5, deadline: new Date('2026-04-07T09:00:00').toISOString(), pausedRemaining: null },
    });
    const deps = makeDeps({
      projectStore: {
        loadAll: vi.fn().mockResolvedValue([project]),
        load: vi.fn(),
        isVacation: vi.fn().mockResolvedValue(false),
      } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // Fire hourly interval

    expect(vi.mocked(deps.commandRouter.autoDecide).mock.calls[0].slice(0, 2)).toEqual([project, expect.any(Function)]);
    expect(deps.broadcast).toHaveBeenCalledWith('auto-decided', 'test', '/tmp');
  });

  it('reports each auto-decide turn on the feed as a cron run', async () => {
    vi.setSystemTime(new Date('2026-04-07T10:00:00'));
    const project = makeProject({
      decision: { summary: 'pick DB', rating: 5, deadline: new Date('2026-04-07T09:00:00').toISOString(), pausedRemaining: null },
    });
    const feed = new Feed();
    const autoDecide = vi.fn(async (_p: unknown, onMessage?: (t: string, m?: { parentId: string }) => void, onToolUse?: (n: string, d: string, m?: object) => void) => {
      onToolUse?.('Bash', 'ls', { parentId: null });
      onMessage?.('sub says', { parentId: 'sa-1' });
      onMessage?.('{"tldr":"Picked **Postgres**.","decision":"Migrate now?","rating":4}');
      return 'auto-decided';
    });
    const deps = makeDeps({
      commandRouter: { autoDecide, isBusy: vi.fn().mockReturnValue(false), stopSlug: vi.fn() } as unknown as CommandRouter,
      projectStore: { loadAll: vi.fn().mockResolvedValue([project]), load: vi.fn(), isVacation: vi.fn().mockResolvedValue(false) } as unknown as ProjectStore,
      feed,
    });
    await runAutoDecidePass(deps);
    const evs = feed.since(0);
    expect(evs.map(e => e.type)).toEqual(['run', 'agent_state', 'tool', 'message', 'message', 'done', 'agent_state']);
    expect(evs[0]).toMatchObject({ slug: 'test', type: 'run', source: 'cron' });
    expect(new Set(evs.map(e => e.runId)).size).toBe(1);
    expect(evs.find(e => e.type === 'done')).toMatchObject({ speech: 'Picked Postgres.', decision: 'Migrate now?', rating: 4 });
    expect(evs[evs.length - 1]).toMatchObject({ type: 'agent_state', busy: false });
    // /events still gets only the main session's text
    expect(vi.mocked(deps.broadcast).mock.calls.map(c => c[0])).not.toContain('sub says');
  });

  it('skips auto-decide outside active hours', async () => {
    // 3AM — inactive hour
    vi.setSystemTime(new Date('2026-04-07T03:00:00'));

    const project = makeProject({
      decision: { summary: 'task', rating: 3, deadline: new Date('2026-04-07T01:00:00').toISOString(), pausedRemaining: null },
    });
    const deps = makeDeps({
      projectStore: {
        loadAll: vi.fn().mockResolvedValue([project]),
        load: vi.fn(),
        isVacation: vi.fn().mockResolvedValue(false),
      } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(deps.commandRouter.autoDecide).not.toHaveBeenCalled();
  });

  it('skips auto-decide during vacation mode', async () => {
    vi.setSystemTime(new Date('2026-04-07T10:00:00'));

    const project = makeProject({
      decision: { summary: 'task', rating: 3, deadline: new Date('2026-04-07T09:00:00').toISOString(), pausedRemaining: null },
    });
    const deps = makeDeps({
      projectStore: {
        loadAll: vi.fn().mockResolvedValue([project]),
        load: vi.fn(),
        isVacation: vi.fn().mockResolvedValue(true),
      } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(deps.commandRouter.autoDecide).not.toHaveBeenCalled();
  });

  it('skips projects without deadline', async () => {
    vi.setSystemTime(new Date('2026-04-07T10:00:00'));

    const project = makeProject({ decision: null });
    const deps = makeDeps({
      projectStore: {
        loadAll: vi.fn().mockResolvedValue([project]),
        load: vi.fn(),
        isVacation: vi.fn().mockResolvedValue(false),
      } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(deps.commandRouter.autoDecide).not.toHaveBeenCalled();
  });

  it('skips projects with future deadline', async () => {
    vi.setSystemTime(new Date('2026-04-07T10:00:00'));

    const project = makeProject({
      decision: { summary: 'task', rating: 3, deadline: new Date('2026-04-07T14:00:00').toISOString(), pausedRemaining: null },
    });
    const deps = makeDeps({
      projectStore: {
        loadAll: vi.fn().mockResolvedValue([project]),
        load: vi.fn(),
        isVacation: vi.fn().mockResolvedValue(false),
      } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(deps.commandRouter.autoDecide).not.toHaveBeenCalled();
  });

  it('skips projects with autoDecide=false', async () => {
    vi.setSystemTime(new Date('2026-04-07T10:00:00'));

    const project = makeProject({
      autoDecide: false,
      decision: { summary: 'task', rating: 3, deadline: new Date('2026-04-07T09:00:00').toISOString(), pausedRemaining: null },
    });
    const deps = makeDeps({
      projectStore: {
        loadAll: vi.fn().mockResolvedValue([project]),
        load: vi.fn(),
        isVacation: vi.fn().mockResolvedValue(false),
      } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(deps.commandRouter.autoDecide).not.toHaveBeenCalled();
  });

  it('prevents concurrent auto-decide runs (lock flag)', async () => {
    vi.setSystemTime(new Date('2026-04-07T10:00:00'));

    let resolveFirst!: () => void;
    const blockFirst = new Promise<void>(res => { resolveFirst = res; });

    const project = makeProject({
      decision: { summary: 'task', rating: 3, deadline: new Date('2026-04-07T09:00:00').toISOString(), pausedRemaining: null },
    });

    const deps = makeDeps({
      commandRouter: {
        autoDecide: vi.fn().mockReturnValue(blockFirst.then(() => 'done')),
      isBusy: vi.fn().mockReturnValue(false),
        stopSlug: vi.fn().mockReturnValue({ stopped: false, reason: 'no session' }),
      } as unknown as CommandRouter,
      projectStore: {
        loadAll: vi.fn().mockResolvedValue([project]),
        load: vi.fn(),
        isVacation: vi.fn().mockResolvedValue(false),
      } as unknown as ProjectStore,
    });

    startCronJobs(deps);

    // Fire first tick — autoDecide starts but never resolves (blockFirst)
    // Use non-async advance so the interval callback starts but we don't await it
    vi.advanceTimersByTime(60 * 60 * 1000);
    // Flush microtasks so the callback reaches `autoDecide` and sets autoDecideRunning = true
    await Promise.resolve();
    await Promise.resolve();

    // Fire second tick — should be skipped due to lock
    vi.advanceTimersByTime(60 * 60 * 1000);
    await Promise.resolve();
    await Promise.resolve();

    // autoDecide called only once (second tick skipped)
    expect(deps.commandRouter.autoDecide).toHaveBeenCalledTimes(1);
    resolveFirst();
  });

  it('times out and continues to next project after 15 minutes', async () => {
    vi.setSystemTime(new Date('2026-04-07T10:00:00'));

    const p1 = makeProject({ slug: 'slow', decision: { summary: 'slow', rating: 3, deadline: new Date('2026-04-07T09:00:00').toISOString(), pausedRemaining: null } });
    const p2 = makeProject({ slug: 'ok', decision: { summary: 'ok', rating: 3, deadline: new Date('2026-04-07T09:00:00').toISOString(), pausedRemaining: null } });

    const deps = makeDeps({
      commandRouter: {
        autoDecide: vi.fn()
          .mockReturnValueOnce(new Promise(() => {})) // hangs forever
          .mockResolvedValueOnce('success'),
      isBusy: vi.fn().mockReturnValue(false),
        stopSlug: vi.fn().mockReturnValue({ stopped: true, reason: 'timed out' }),
      } as unknown as CommandRouter,
      projectStore: {
        loadAll: vi.fn().mockResolvedValue([p1, p2]),
        load: vi.fn(),
        isVacation: vi.fn().mockResolvedValue(false),
      } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    // Fire the hourly tick, then advance past the 15-min timeout
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 15 * 60 * 1000 + 1000);

    // Slow project timed out, but second project still ran
    expect(deps.commandRouter.autoDecide).toHaveBeenCalledTimes(2);
    expect(deps.broadcast).toHaveBeenCalledWith('success', 'ok', '/tmp');
  });

  it('continues processing remaining projects when one throws', async () => {
    vi.setSystemTime(new Date('2026-04-07T10:00:00'));

    const p1 = makeProject({ slug: 'broken', decision: { summary: 'fail', rating: 3, deadline: new Date('2026-04-07T09:00:00').toISOString(), pausedRemaining: null } });
    const p2 = makeProject({ slug: 'ok', decision: { summary: 'ok', rating: 3, deadline: new Date('2026-04-07T09:00:00').toISOString(), pausedRemaining: null } });

    const deps = makeDeps({
      commandRouter: {
        autoDecide: vi.fn()
          .mockRejectedValueOnce(new Error('Muse error'))
          .mockResolvedValueOnce('success'),
      isBusy: vi.fn().mockReturnValue(false),
      } as unknown as CommandRouter,
      projectStore: {
        loadAll: vi.fn().mockResolvedValue([p1, p2]),
        load: vi.fn(),
        isVacation: vi.fn().mockResolvedValue(false),
      } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    // Both were attempted, second succeeded
    expect(deps.commandRouter.autoDecide).toHaveBeenCalledTimes(2);
    expect(deps.broadcast).toHaveBeenCalledWith('success', 'ok', '/tmp');
  });
});

}); // Cron

describe('mainSessionOnly', () => {
  it('forwards main-session text and drops subagent text (no threads on the cron path)', () => {
    const sent: string[] = [];
    const onMessage = mainSessionOnly((t) => sent.push(t));
    onMessage('main');
    onMessage('from agent', { parentId: 'toolu_A' });
    expect(sent).toEqual(['main']);
  });
});

describe('auto-decide skips busy slugs', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('defers a slug that already has a run instead of queueing behind it', async () => {
    vi.setSystemTime(new Date('2026-04-07T10:00:00'));
    const project = makeProject({ decision: { summary: 'x', rating: 1, deadline: new Date('2026-04-07T09:00:00').toISOString(), pausedRemaining: null } });
    const deps = makeDeps({
      projectStore: {
        loadAll: vi.fn().mockResolvedValue([project]),
        load: vi.fn(),
        isVacation: vi.fn().mockResolvedValue(false),
      } as unknown as ProjectStore,
    });
    (deps.commandRouter.isBusy as ReturnType<typeof vi.fn>).mockReturnValue(true);
    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(deps.commandRouter.autoDecide).not.toHaveBeenCalled();
    expect(deps.commandRouter.stopSlug).not.toHaveBeenCalled();
  });
});
