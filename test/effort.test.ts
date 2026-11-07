import { describe, it, expect } from 'vitest';
import { parseEffort } from '../src/command-router.js';

describe('parseEffort', () => {
  it('strips a leading prefix', () => {
    expect(parseEffort('Effort: max\nfix the bug')).toEqual({ effort: 'max', text: 'fix the bug' });
    expect(parseEffort('effort: xhigh refactor ultracode')).toEqual({ effort: 'xhigh', text: 'refactor ultracode' });
  });
  it('detects it anywhere in the prompt', () => {
    expect(parseEffort('fix the bug effort: max')).toEqual({ effort: 'max', text: 'fix the bug' });
    expect(parseEffort('fix Effort: high the bug')).toEqual({ effort: 'high', text: 'fix the bug' });
    expect(parseEffort('line one\nEffort: low\nline three')).toEqual({ effort: 'low', text: 'line one\nline three' });
    expect(parseEffort('Do X. Effort: max.')).toEqual({ effort: 'max', text: 'Do X..' });
  });
  it('highest level wins and every token is stripped', () => {
    expect(parseEffort('1. a Effort: low\n2. b Effort: xhigh')).toEqual({ effort: 'xhigh', text: '1. a\n2. b' });
  });
  it('ignores unknown levels, placeholders and quoted syntax', () => {
    expect(parseEffort('Effort: extreme go')).toEqual({ text: 'Effort: extreme go' });
    expect(parseEffort('use `Effort: <level>` here')).toEqual({ text: 'use `Effort: <level>` here' });
    expect(parseEffort('say `Effort: max` to try')).toEqual({ text: 'say `Effort: max` to try' });
    expect(parseEffort('say "Effort: max" to try')).toEqual({ text: 'say "Effort: max" to try' });
    expect(parseEffort('no effort needed')).toEqual({ text: 'no effort needed' });
  });
});
