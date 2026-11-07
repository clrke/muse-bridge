/**
 * Muse Code usage, for GET /usage. Two sources:
 *  - every `muse exec --json` run ends with a `run.usage` event (token counts per model; its
 *    `allowance` member carries the subscription window when the account has one), and
 *  - `muse usage --json` (no model turn) prints `{allowance}` — null with reason `no_allowance`
 *    on the accounts seen so far, so the percentages are best-effort: the shape
 *    follows Muse's MSP `SubscriptionUsage` (tier, weekly, window) and is unverified against a
 *    real non-null reply. Token totals are always real.
 */
import fs from 'node:fs';
import { execFile } from 'node:child_process';

export interface MuseAllowance {
  tier: string;
  /** 0–100+ (the provider's integer percent), resetsAt in epoch ms. */
  weekly: { usedPercent: number; resetsAt: number } | null;
  window: { usedPercent: number; resetsAt: number; windowMins: number | null } | null;
  observedAt: number;
}

interface Tokens { calls: number; inputTokens: number; cachedTokens: number; outputTokens: number }

export interface MuseUsage {
  observedAt: number;
  /** Project of the most recent Muse run. */
  slug: string;
  lastRun: Tokens & { model: string };
  /** Totals since local midnight (`date` = YYYY-MM-DD). */
  today: Tokens & { date: string };
  allowance: MuseAllowance | null;
}

let latest: MuseUsage | null = null;
let usagePath: string | null = null;

export function getMuseUsage(): MuseUsage | null { return latest; }

export function persistMuseUsage(file: string): void {
  usagePath = file;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as MuseUsage;
    if (saved && typeof saved.observedAt === 'number' && !latest) latest = saved;
  } catch { /* none yet */ }
}

/** Test hook: forget everything in memory. */
export function resetMuseUsage(): void { latest = null; usagePath = null; lastPollAt = 0; }

function save(): void {
  if (!usagePath || !latest) return;
  try { fs.writeFileSync(usagePath, JSON.stringify(latest)); } catch { /* best effort */ }
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Tolerant parse of Muse's SubscriptionUsage; null when it has neither window. */
export function parseMuseAllowance(raw: unknown, now = Date.now()): MuseAllowance | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, any>;
  const w = (x: any) => (x && num(x.usedPercent) != null && num(x.resetsAtMs) != null
    ? { usedPercent: x.usedPercent as number, resetsAt: x.resetsAtMs as number } : null);
  const weekly = w(a.weekly);
  const win = w(a.window);
  if (!weekly && !win) return null;
  return {
    tier: typeof a.tier === 'string' ? a.tier : '',
    weekly,
    window: win ? { ...win, windowMins: num(a.window.windowDurationMins) } : null,
    observedAt: num(a.observedAtMs) ?? now,
  };
}

const localDate = (now: number) => new Date(now).toLocaleDateString('en-CA');

/** Fold one run's `run.usage` payload into the running totals. */
export function recordMuseRun(slug: string, payload: Record<string, any>, now = Date.now()): void {
  const models: any[] = Array.isArray(payload.models) ? payload.models : [];
  const sum = (k: string) => models.reduce((n, m) => n + (num(m?.[k]) ?? 0), 0);
  const run: Tokens = {
    calls: num(payload.calls) ?? sum('calls'),
    inputTokens: sum('input_tokens'),
    cachedTokens: sum('cached_tokens'),
    outputTokens: sum('output_tokens'),
  };
  const date = localDate(now);
  const prev = latest?.today.date === date ? latest.today : { date, calls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
  const allowance = parseMuseAllowance(payload.allowance, now) ?? latest?.allowance ?? null;
  latest = {
    observedAt: now,
    slug,
    lastRun: { ...run, model: typeof models[0]?.model === 'string' ? models[0].model : '' },
    today: {
      date,
      calls: prev.calls + run.calls,
      inputTokens: prev.inputTokens + run.inputTokens,
      cachedTokens: prev.cachedTokens + run.cachedTokens,
      outputTokens: prev.outputTokens + run.outputTokens,
    },
    allowance,
  };
  save();
}

let lastPollAt = 0;
const POLL_MIN_INTERVAL_MS = 9 * 60_000;

/** Ask `muse usage --json` for the subscription window; no-op unless a Muse run happened since the last poll. */
export function pollMuseAllowance(bin: string, now = Date.now()): Promise<void> {
  if (!latest || latest.observedAt <= lastPollAt || now - lastPollAt < POLL_MIN_INTERVAL_MS) return Promise.resolve();
  lastPollAt = now;
  return new Promise((resolve) => {
    execFile(bin, ['usage', '--json'], { timeout: 20_000 }, (err, stdout) => {
      if (!err && latest) {
        try {
          const allowance = parseMuseAllowance(JSON.parse(stdout).allowance, now);
          if (allowance) { latest = { ...latest, allowance }; save(); }
        } catch { /* not JSON */ }
      }
      resolve();
    });
  });
}
