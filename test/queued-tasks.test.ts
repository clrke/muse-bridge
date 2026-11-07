import { describe, it, expect } from 'vitest';
import { parseQueuedTask, buildQueuedDrainPrompt } from '../src/command-router.js';

describe('parseQueuedTask', () => {
  it('classifies "For later:" and its aliases as later', () => {
    expect(parseQueuedTask('For later: fix the oars')).toEqual({ kind: 'later', task: 'fix the oars' });
    expect(parseQueuedTask('todo: x')).toEqual({ kind: 'later', task: 'x' });
  });

  it('classifies "Continuation:" and its aliases as continuation', () => {
    expect(parseQueuedTask('Continuation: add tests\n\nand docs')).toEqual({ kind: 'continuation', task: 'add tests\n\nand docs' });
    expect(parseQueuedTask('  continue with: polish')).toEqual({ kind: 'continuation', task: 'polish' });
    expect(parseQueuedTask('After that: ship it')?.kind).toBe('continuation');
    expect(parseQueuedTask('afterwards: ship it')?.kind).toBe('continuation');
    expect(parseQueuedTask('Next up: ship it')?.kind).toBe('continuation');
  });

  it('only matches an anchored prefix', () => {
    expect(parseQueuedTask('add a continuation: field')).toBeNull();
    expect(parseQueuedTask('continue the work')).toBeNull();
    expect(parseQueuedTask('next: thing')).toBeNull();
  });
});

describe('buildQueuedDrainPrompt', () => {
  it('continuation-only never mentions holding off', () => {
    const one = buildQueuedDrainPrompt([{ kind: 'continuation', task: 'A' }]);
    expect(one).toBe('Continue with this next:\n\nA');
    const two = buildQueuedDrainPrompt([{ kind: 'continuation', task: 'A' }, { kind: 'continuation', task: 'B' }]);
    expect(two).toBe('Continue with these next:\n\n1. A\n2. B');
    expect(one + two).not.toMatch(/hold off/i);
  });

  it('later-only keeps the existing hold-off reframe', () => {
    expect(buildQueuedDrainPrompt([{ kind: 'later', task: 'A' }])).toMatch(/^Hold off on this for now[\s\S]*work on this next:\n\nA$/);
  });

  it('mixed batch scopes the hold-off to later items and appends continuations', () => {
    const p = buildQueuedDrainPrompt([
      { kind: 'continuation', task: 'C1' },
      { kind: 'later', task: 'L1' },
      { kind: 'later', task: 'L2' },
    ]);
    expect(p).toMatch(/^Hold off on these for now/);
    expect(p).toContain('1. L1\n2. L2');
    expect(p.endsWith('\n\nThen continue with:\n\nC1')).toBe(true);
  });
});
