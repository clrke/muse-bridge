import type { ProjectStore } from './project-store.js';
import type { CommandRouter } from './command-router.js';
import type { Config } from './config.js';
import { hasDeadlinePassed, isActiveHour } from './deadline.js';

/**
 * Cron-driven turns have no per-subagent stream, so subagent text is dropped rather than
 * mixed into the main project feed.
 */
export function mainSessionOnly(send: (text: string) => void): (text: string, meta?: { parentId: string }) => void {
  return (text, meta) => { if (!meta?.parentId) send(text); };
}

export interface CronDeps {
  commandRouter: CommandRouter;
  projectStore: ProjectStore;
  config: Pick<Config, 'autoDecideTimeoutMs'>;
  /** Pushes a message to every /events subscriber. */
  broadcast: (text: string, slug?: string, projectDirectory?: string) => void;
}

/**
 * One auto-decide pass: every project with `autoDecide: true` whose pending decision's
 * deadline has passed gets "make an informed decision for me". Active hours only (9:00-21:00
 * local), never on vacation, one project at a time. Exported for tests.
 */
export async function runAutoDecidePass(deps: CronDeps, now = new Date()): Promise<void> {
  const { commandRouter, projectStore, broadcast, config } = deps;
  const hour = now.getHours();
  if (!isActiveHour(hour)) {
    console.log(`[Cron] Skipping auto-decide check (hour ${hour} outside 9AM-9PM)`);
    return;
  }
  if (await projectStore.isVacation()) {
    console.log('[Cron] Skipping auto-decide (vacation mode)');
    return;
  }

  const projects = await projectStore.loadAll();
  for (const project of projects) {
    if (!project.autoDecide) continue;
    if (!project.decision?.deadline) continue;
    if (!hasDeadlinePassed(project.decision.deadline, now)) continue;
    // A run already holds this slug (often a client's own turn): the timeout below would
    // count the queue wait and its stopSlug would kill that run. Try again next tick.
    if (commandRouter.isBusy(project.slug)) {
      console.log(`[Cron] ${project.slug}: busy, auto-decide deferred to the next tick`);
      continue;
    }

    console.log(`[Cron] Auto-deciding for ${project.slug}...`);
    const send = (text: string) => broadcast(text, project.slug, project.directory);
    try {
      let timer: ReturnType<typeof setTimeout>;
      const timeoutMs = config.autoDecideTimeoutMs;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`auto-decide timed out after ${Math.round(timeoutMs / 60_000)} minutes`)), timeoutMs);
      });
      const response = await Promise.race([
        commandRouter.autoDecide(project, mainSessionOnly(send)).finally(() => clearTimeout(timer!)),
        timeout,
      ]);
      send(response);
    } catch (err) {
      console.error(`[Cron] Auto-decide failed for ${project.slug}: ${(err as Error).message}`);
      // Promise.race doesn't cancel the loser: if the timeout won, the turn is still running
      // and holding this slug's queue. Force-stop it so the slug is really free again.
      if (/timed out after/.test((err as Error).message)) {
        const stopResult = commandRouter.stopSlug(project.slug);
        console.warn(`[Cron] ${project.slug}: force-stopped after auto-decide timeout: ${stopResult.reason}`);
        send(`⏹️ Auto-decide stopped after ${Math.round(config.autoDecideTimeoutMs / 60_000)} min without finishing; the decision is still pending.`);
      }
    }
  }
}

/** Start the hourly auto-decide job. Returns a function that stops it. */
export function startCronJobs(deps: CronDeps, intervalMs = 60 * 60 * 1000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) {
      console.log('[Cron] Skipping auto-decide tick: previous cycle still running');
      return;
    }
    running = true;
    try {
      await runAutoDecidePass(deps);
    } catch (err) {
      console.error(`[Cron] Auto-decide tick failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
  console.log('[Cron] Started: auto-decide (hourly, 9AM-9PM)');
  return () => clearInterval(timer);
}
