import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ago, findProjects, readmeExcerpt, recentFiles, resolveScanRoots, scanProjects } from '../src/discovery.js';

let tmp: string;
const NOW = Date.now();
const MIN = 60_000;

/** Write a file and set its mtime to `minutesAgo` before NOW. */
async function file(rel: string, minutesAgo: number, content = 'x') {
  const p = path.join(tmp, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
  const t = new Date(NOW - minutesAgo * MIN);
  await fs.utimes(p, t, t);
}

/** Age every directory under the fixture so only file mtimes decide recency. */
async function ageDirs(dir = tmp, minutesAgo = 10_000) {
  const t = new Date(NOW - minutesAgo * MIN);
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) await ageDirs(path.join(dir, e.name), minutesAgo);
  }
  await fs.utimes(dir, t, t);
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'muse-bridge-scan-')));
  // code/todo-api: a git repo edited 5 min ago (a newer file sits in node_modules: ignored)
  await fs.mkdir(path.join(tmp, 'code/todo-api/.git'), { recursive: true });
  await file('code/todo-api/package.json', 300);
  await file('code/todo-api/src/server.ts', 5);
  await file('code/todo-api/src/routes/users.ts', 7);
  await file('code/todo-api/README.md', 9, '# Todo API\nA small REST API for todos.');
  await file('code/todo-api/node_modules/dep/index.js', 1);
  await file('code/todo-api/.env', 0);
  // code/clients/my-app: Python, two levels down, edited 60 min ago
  await file('code/clients/my-app/pyproject.toml', 600);
  await file('code/clients/my-app/app/main.py', 60);
  // code/game: Unity (ProjectSettings), edited 2 days ago; Library is ignored
  await file('code/game/ProjectSettings/ProjectVersion.txt', 3000);
  await file('code/game/Assets/Player.cs', 2880);
  await file('code/game/Library/cache.bin', 0);
  // code/old-lib: Rust, edited a month ago
  await file('code/old-lib/Cargo.toml', 43_000);
  // code/notes: not a project; code/.hidden/x: hidden; code/a/b/c/d/deep: too deep
  await file('code/notes/todo.txt', 0);
  await file('code/.hidden/x/package.json', 0);
  await file('code/a/b/c/d/deep/go.mod', 0);
  // a project inside a project is not listed separately
  await file('code/todo-api/packages/inner/package.json', 2);
  await ageDirs();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('resolveScanRoots', () => {
  it('uses the explicit roots that exist, else the default code folders, else home at depth 2', async () => {
    expect(await resolveScanRoots([path.join(tmp, 'code'), path.join(tmp, 'nope')], tmp)).toEqual([{ dir: path.join(tmp, 'code'), depth: 3 }]);
    expect(await resolveScanRoots(['~/code'], tmp)).toEqual([{ dir: path.join(tmp, 'code'), depth: 3 }]);
    expect(await resolveScanRoots([], tmp)).toEqual([{ dir: path.join(tmp, 'code'), depth: 3 }]);
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-bridge-home-'));
    try {
      expect(await resolveScanRoots([], empty)).toEqual([{ dir: empty, depth: 2 }]);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});

describe('findProjects', () => {
  it('finds project roots up to depth 3, skipping hidden, heavy and nested dirs', async () => {
    const found = await findProjects([{ dir: path.join(tmp, 'code'), depth: 3 }]);
    expect(found.map(d => path.relative(tmp, d))).toEqual(['code/clients/my-app', 'code/game', 'code/old-lib', 'code/todo-api']);
  });
});

describe('recentFiles', () => {
  it('returns the newest files, skipping heavy and hidden entries, within the entry budget', async () => {
    const r = await recentFiles(path.join(tmp, 'code/todo-api'));
    expect(r.files).toEqual(['packages/inner/package.json', 'src/server.ts', 'src/routes/users.ts']);
    expect(r.lastModified).toBeCloseTo(NOW - 2 * MIN, -3);
    const tiny = await recentFiles(path.join(tmp, 'code/todo-api'), 2);
    expect(tiny.files.length).toBeLessThanOrEqual(2);
  });
});

describe('scanProjects', () => {
  it('ranks by the newest edit, drops registered directories and keeps the limit', async () => {
    const roots = [{ dir: path.join(tmp, 'code'), depth: 3 }];
    const all = await scanProjects(roots);
    expect(all.map(c => c.name)).toEqual(['todo-api', 'my-app', 'game', 'old-lib']);
    expect(all[1]).toMatchObject({ directory: path.join(tmp, 'code/clients/my-app'), recentFiles: ['app/main.py', 'pyproject.toml'] });
    expect(all[1].lastModified).toBeCloseTo(NOW - 60 * MIN, -3);

    const some = await scanProjects(roots, { exclude: [path.join(tmp, 'code/todo-api') + '/'], limit: 2 });
    expect(some.map(c => c.name)).toEqual(['my-app', 'game']);
  });
});

describe('helpers', () => {
  it('reads a README excerpt', async () => {
    expect(await readmeExcerpt(path.join(tmp, 'code/todo-api'), 10)).toBe('# Todo API');
    expect(await readmeExcerpt(path.join(tmp, 'code/old-lib'))).toBeNull();
  });
  it('says how long ago', () => {
    expect(ago(NOW - 10_000, NOW)).toBe('just now');
    expect(ago(NOW - 12 * MIN, NOW)).toBe('12 min ago');
    expect(ago(NOW - 180 * MIN, NOW)).toBe('3 h ago');
    expect(ago(NOW - 72 * 60 * MIN, NOW)).toBe('3 days ago');
  });
});
