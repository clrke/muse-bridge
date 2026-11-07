import { describe, it, expect, vi } from 'vitest';
import {
  Suggestions, buildRankPrompt, fallbackSuggestions, heuristicReason, isUsableSlug, parseRanking, slugify, uniqueSlug,
  type SuggestionsSnapshot,
} from '../src/suggestions.js';
import type { Candidate } from '../src/discovery.js';

const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const MIN = 60_000;
const cands: Candidate[] = [
  { name: 'todo-api', directory: '/home/me/code/todo-api', lastModified: NOW - 12 * MIN, recentFiles: ['src/app.ts', 'README.md'] },
  { name: 'My App', directory: '/home/me/code/my-app', lastModified: NOW - 3 * 60 * MIN, recentFiles: [] },
  { name: 'list', directory: '/home/me/code/list', lastModified: NOW - 4 * 60 * MIN, recentFiles: ['main.go'] },
];

describe('slugs', () => {
  it('slugifies, rejects reserved/taken/invalid ones and makes unique ones', () => {
    expect(slugify('My App!')).toBe('my-app');
    expect(slugify('  __ ')).toBe('');
    expect(isUsableSlug('my-app', new Set())).toBe(true);
    expect(isUsableSlug('My-App', new Set())).toBe(false);
    expect(isUsableSlug('-x', new Set())).toBe(false);
    expect(isUsableSlug('my_app', new Set())).toBe(false);
    expect(isUsableSlug('register', new Set())).toBe(false);
    expect(isUsableSlug('taken', new Set(['taken']))).toBe(false);
    expect(uniqueSlug('taken', new Set(['taken', 'taken-2']))).toBe('taken-3');
    expect(uniqueSlug('help', new Set())).toBe('help-2');
    expect(uniqueSlug('!!!', new Set())).toBe('project');
  });
});

describe('fallback', () => {
  it('keeps the recency order with "Edited … ago: files" reasons and unique slugs', () => {
    expect(heuristicReason(cands[0], NOW)).toBe('Edited 12 min ago: src/app.ts, README.md');
    const items = fallbackSuggestions(cands, new Set(['todo-api']), NOW);
    expect(items.map(i => [i.slug, i.title, i.reason])).toEqual([
      ['todo-api-2', 'todo-api', 'Edited 12 min ago: src/app.ts, README.md'],
      ['my-app', 'My App', 'Edited 3 h ago'],
      ['list-2', 'list', 'Edited 4 h ago: main.go'],
    ]);
    expect(items[0]).toMatchObject({ directory: '/home/me/code/todo-api', lastModified: new Date(NOW - 12 * MIN).toISOString(), recentFiles: ['src/app.ts', 'README.md'] });
  });
});

describe('parseRanking', () => {
  it('accepts a valid array, bare or in a fence or prose', () => {
    const arr = [{ slug: 'my-app', title: 'My App', directory: '/home/me/code/my-app', reason: 'Wiring the login screen' }];
    for (const text of [JSON.stringify(arr), '```json\n' + JSON.stringify(arr) + '\n```', `Here you go:\n${JSON.stringify(arr)}\nEnjoy`, JSON.stringify({ suggestions: arr })]) {
      expect(parseRanking(text, cands, new Set())).toEqual([{
        slug: 'my-app', title: 'My App', directory: '/home/me/code/my-app', reason: 'Wiring the login screen',
        lastModified: new Date(cands[1].lastModified).toISOString(), recentFiles: [],
      }]);
    }
  });

  it('drops unknown and repeated directories, repairs bad, reserved, taken and duplicate slugs', () => {
    const text = JSON.stringify([
      { slug: 'evil', directory: '/etc', reason: 'x' },
      { slug: 'Todo API', directory: '/home/me/code/todo-api', title: 'Todo API', reason: 'Adding\npagination' },
      { slug: 'other', directory: '/home/me/code/todo-api/', reason: 'dup dir' },
      { slug: 'help', directory: '/home/me/code/list', reason: 'Go CLI' },
      { slug: 'todo-api', directory: '/home/me/code/my-app' },
      'junk', null, { directory: 42 },
    ]);
    const items = parseRanking(text, cands, new Set(['taken']))!;
    expect(items.map(i => [i.slug, i.directory])).toEqual([
      ['todo-api', '/home/me/code/todo-api'],
      ['help-2', '/home/me/code/list'],
      ['todo-api-2', '/home/me/code/my-app'],
    ]);
    expect(items[0].reason).toBe('Adding pagination');
    expect(items[2]).toMatchObject({ title: 'My App', reason: expect.stringMatching(/^Edited /) });
    expect(new Set(items.map(i => i.slug)).size).toBe(items.length);
  });

  it('returns null for garbage or nothing usable', () => {
    expect(parseRanking('I think todo-api looks fun', cands, new Set())).toBeNull();
    expect(parseRanking('[]', cands, new Set())).toBeNull();
    expect(parseRanking('[{"slug":"x","directory":"/nope"}]', cands, new Set())).toBeNull();
    expect(parseRanking('{"slug":"x"}', cands, new Set())).toBeNull();
  });

  it('keeps at most 5', () => {
    const many: Candidate[] = Array.from({ length: 8 }, (_, i) => ({ name: `p${i}`, directory: `/c/p${i}`, lastModified: NOW, recentFiles: [] }));
    const text = JSON.stringify(many.map(c => ({ slug: c.name, directory: c.directory, title: c.name, reason: 'r' })));
    expect(parseRanking(text, many, new Set())).toHaveLength(5);
  });
});

describe('buildRankPrompt', () => {
  it('carries every candidate, the taken slugs and a no-tools instruction', () => {
    const p = buildRankPrompt(cands.map(c => ({ ...c, readme: c.name === 'todo-api' ? '# Todo API' : null })), new Set(['site']), NOW);
    expect(p).toMatch(/Do NOT use any tools/);
    expect(p).toContain('directory: /home/me/code/todo-api');
    expect(p).toContain('recent files: src/app.ts, README.md');
    expect(p).toContain('README excerpt: "# Todo API"');
    expect(p).toContain('12 min ago');
    expect(p).toContain('must not be one of: site');
  });
});

describe('Suggestions state machine', () => {
  const make = (rank?: (p: string) => Promise<string>, scan: (exclude: string[]) => Promise<Candidate[]> = async () => cands) => {
    const states: SuggestionsSnapshot[] = [];
    const s = new Suggestions({
      enabled: true, scan, rank, now: () => NOW, log: () => {},
      registered: async () => [{ slug: 'site', directory: '/home/me/code/site' }],
      readme: async () => null,
      onChange: snap => states.push(snap),
    });
    return { s, states };
  };

  it('goes idle → scanning → ranking → ready with Muse\'s ranking', async () => {
    const rank = vi.fn(async () => JSON.stringify([{ slug: 'todo', title: 'Todo', directory: '/home/me/code/todo-api', reason: 'Auth refactor' }]));
    const { s, states } = make(rank);
    expect(s.snapshot()).toEqual({ state: 'idle', updatedAt: null, items: [], enabled: true });
    const snap = await s.refresh();
    expect(states.map(x => x.state)).toEqual(['scanning', 'ranking', 'ready']);
    expect(snap).toMatchObject({ state: 'ready', updatedAt: new Date(NOW).toISOString(), items: [{ slug: 'todo', reason: 'Auth refactor' }] });
    expect(rank).toHaveBeenCalledOnce();
  });

  it('falls back to recency order when Muse fails or answers garbage', async () => {
    for (const rank of [async () => { throw new Error('timed out after 90s'); }, async () => 'Sure! Here are my thoughts…']) {
      const { s } = make(rank);
      const snap = await s.refresh();
      expect(snap.state).toBe('ready');
      expect(snap.items.map(i => i.slug)).toEqual(['todo-api', 'my-app', 'list-2']);
      expect(snap.items[0].reason).toBe('Edited 12 min ago: src/app.ts, README.md');
    }
  });

  it('passes registered directories to the scan, joins a running refresh, fails cleanly', async () => {
    const scan = vi.fn(async (_exclude: string[]) => cands);
    const { s } = make(undefined, scan);
    const [a, b] = [s.refresh(), s.refresh()];
    expect(a).toBe(b);
    await a;
    expect(scan).toHaveBeenCalledOnce();
    expect(scan.mock.calls[0][0]).toEqual(['/home/me/code/site']);

    const broken = make(undefined, async () => { throw new Error('EACCES'); });
    expect(await broken.s.refresh()).toMatchObject({ state: 'failed', items: [], error: 'EACCES' });
  });

  it('removes, dismisses (and keeps dismissed out of later refreshes) and prunes registered ones', async () => {
    let registered = [{ slug: 'site', directory: '/home/me/code/site' }];
    const s = new Suggestions({ enabled: true, scan: async () => cands, registered: async () => registered, log: () => {} });
    await s.refresh();
    expect(s.remove('nope')).toBe(false);
    expect(s.remove('my-app', { dismiss: true })).toBe(true);
    expect((await s.refresh()).items.map(i => i.slug)).toEqual(['todo-api', 'list-2']);
    registered = [...registered, { slug: 'other', directory: '/home/me/code/todo-api' }];
    await s.pruneRegistered();
    expect(s.snapshot().items.map(i => i.slug)).toEqual(['list-2']);
  });

  it('does nothing when disabled', async () => {
    const scan = vi.fn(async () => cands);
    const s = new Suggestions({ enabled: false, scan, registered: async () => [] });
    expect(await s.refresh()).toEqual({ state: 'idle', updatedAt: null, items: [], enabled: false });
    expect(scan).not.toHaveBeenCalled();
  });
});
