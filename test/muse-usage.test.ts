import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getMuseUsage, parseMuseAllowance, persistMuseUsage, recordMuseRun, resetMuseUsage } from '../src/muse-usage.js';

// run.usage payload as recorded from Muse Code 1.4.14 (allowance null on the contributor account).
const payload = (input: number, out: number, extra: object = {}) => ({
  kind: 'run_usage', calls: 3, allowance: null,
  models: [{ model: 'muse-spark-1.3-contributor', input_tokens: input, cached_tokens: 100, output_tokens: out, reasoning_tokens: 5, calls: 3 }],
  ...extra,
});
const NOON = new Date(2026, 9, 28, 12, 0).getTime();
const NEXT_DAY = new Date(2026, 9, 29, 9, 0).getTime();

describe('Muse usage', () => {
  beforeEach(() => resetMuseUsage());

  it('sums runs per local day and tracks the last run', () => {
    recordMuseRun('bots', payload(1000, 20), NOON);
    recordMuseRun('bots', payload(500, 10), NOON + 60_000);
    const u = getMuseUsage()!;
    expect(u.slug).toBe('bots');
    expect(u.lastRun).toMatchObject({ calls: 3, inputTokens: 500, outputTokens: 10, model: 'muse-spark-1.3-contributor' });
    expect(u.today).toMatchObject({ date: '2026-10-28', calls: 6, inputTokens: 1500, cachedTokens: 200, outputTokens: 30 });
    expect(u.allowance).toBeNull();
    recordMuseRun('bots', payload(7, 1), NEXT_DAY);
    expect(getMuseUsage()!.today).toMatchObject({ date: '2026-10-29', calls: 3, inputTokens: 7 });
  });

  it('parses a subscription window (MSP SubscriptionUsage shape) and keeps it across null reports', () => {
    const allowance = { observedAtMs: NOON, tier: 'pro', weekly: { resetsAtMs: NOON + 5e8, usedPercent: 12 }, window: { resetsAtMs: NOON + 1e7, usedPercent: 3, windowDurationMins: 300 } };
    expect(parseMuseAllowance(allowance)).toEqual({
      tier: 'pro', weekly: { usedPercent: 12, resetsAt: NOON + 5e8 }, window: { usedPercent: 3, resetsAt: NOON + 1e7, windowMins: 300 }, observedAt: NOON,
    });
    expect(parseMuseAllowance(null)).toBeNull();
    expect(parseMuseAllowance({ tier: 'x' })).toBeNull();
    recordMuseRun('bots', payload(1, 1, { allowance }), NOON);
    recordMuseRun('bots', payload(1, 1), NOON + 1000); // later run reports null → keep the last known window
    expect(getMuseUsage()!.allowance?.tier).toBe('pro');
  });

  it('persists and restores', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'museu-')), 'u.json');
    persistMuseUsage(file);
    recordMuseRun('bots', payload(9, 2), NOON);
    resetMuseUsage();
    persistMuseUsage(file);
    expect(getMuseUsage()!.today.inputTokens).toBe(9);
  });
});
