import { describe, it, expect } from 'vitest';
import {
  ratingToHours,
  calculateDeadline,
  isActiveHour,
  hasDeadlinePassed,
  extendDeadline,
  pauseForVacation,
  deadlineFromActiveHours,
} from '../src/deadline.js';

describe('ratingToHours', () => {
  it('maps ratings to hours correctly', () => {
    expect(ratingToHours(0)).toBe(0);
    expect(ratingToHours(1)).toBe(1);
    expect(ratingToHours(2)).toBe(3);
    expect(ratingToHours(3)).toBe(5);
    expect(ratingToHours(5)).toBe(9);
    expect(ratingToHours(10)).toBe(Infinity); // Critical — never auto-decide
  });
});

describe('isActiveHour', () => {
  it('9AM-8PM are active', () => {
    for (let h = 9; h <= 20; h++) {
      expect(isActiveHour(h)).toBe(true);
    }
  });

  it('9PM-8AM are inactive', () => {
    for (let h = 21; h <= 23; h++) {
      expect(isActiveHour(h)).toBe(false);
    }
    for (let h = 0; h <= 8; h++) {
      expect(isActiveHour(h)).toBe(false);
    }
  });
});

describe('calculateDeadline', () => {
  it('returns same time for rating 0', () => {
    const start = new Date('2026-03-22T14:00:00');
    const deadline = calculateDeadline(0, start);
    expect(deadline.getTime()).toBe(start.getTime());
  });

  it('adds 1 hour for rating 1 during active hours', () => {
    const start = new Date('2026-03-22T10:00:00');
    const deadline = calculateDeadline(1, start);
    expect(deadline.getHours()).toBe(11);
    expect(deadline.getDate()).toBe(22);
  });

  it('skips overnight for rating 2 starting at 8PM', () => {
    // Rating 2 = 3 hours. Start at 8PM (hour 20).
    // +1h=21(skip)...+1h=9(count1), +1h=10(count2), +1h=11(count3)
    const start = new Date('2026-03-22T20:00:00');
    const deadline = calculateDeadline(2, start);
    expect(deadline.getDate()).toBe(23);
    expect(deadline.getHours()).toBe(11);
  });

  it('rating 10 sets deadline to year 9999 (never auto-decide)', () => {
    const start = new Date('2026-03-22T09:00:00');
    const deadline = calculateDeadline(10, start);
    expect(deadline.getFullYear()).toBeGreaterThanOrEqual(9999);
  });
});

describe('hasDeadlinePassed', () => {
  it('returns true when now is past deadline', () => {
    expect(hasDeadlinePassed('2026-03-20T10:00:00', new Date('2026-03-22T10:00:00'))).toBe(true);
  });

  it('returns false when now is before deadline', () => {
    expect(hasDeadlinePassed('2026-03-25T10:00:00', new Date('2026-03-22T10:00:00'))).toBe(false);
  });
});

describe('extendDeadline', () => {
  it('extends by active hours skipping overnight', () => {
    // Extend from 7PM by 5 active hours
    // +1h=20(count1), +1h=21(skip)...+1h=9(count2), +1h=10(count3), +1h=11(count4), +1h=12(count5)
    const result = extendDeadline('2026-03-22T19:00:00', 5);
    const d = new Date(result);
    expect(d.getDate()).toBe(23);
    expect(d.getHours()).toBe(12);
  });
});

describe('pauseForVacation', () => {
  it('counts active hours between now and deadline', () => {
    // 6PM to next day 10AM
    // 6→7(active), 7→8(active), 8→9(active), 9PM→...9AM(skip), 9→10(active) = 4
    const remaining = pauseForVacation('2026-03-23T10:00:00', new Date('2026-03-22T18:00:00'));
    expect(remaining).toBe(4);
  });

  it('returns 0 if deadline already passed', () => {
    const remaining = pauseForVacation('2026-03-20T10:00:00', new Date('2026-03-22T10:00:00'));
    expect(remaining).toBe(0);
  });
});

describe('deadlineFromActiveHours', () => {
  it('calculates deadline from active hours', () => {
    const result = deadlineFromActiveHours(3, new Date('2026-03-22T10:00:00'));
    const d = new Date(result);
    expect(d.getHours()).toBe(13);
    expect(d.getDate()).toBe(22);
  });

  it('returns now for 0 hours', () => {
    const now = new Date('2026-03-22T10:00:00');
    const result = deadlineFromActiveHours(0, now);
    expect(new Date(result).getTime()).toBe(now.getTime());
  });
});
