/**
 * Project discovery: a fast, bounded filesystem scan for the user's most recently edited
 * project directories, then an optional Muse pass that ranks them and says what seems to be in
 * progress. The result backs GET /suggestions.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Never descended into, while finding projects or walking one. */
export const HEAVY_DIRS = new Set([
  'node_modules', '.git', 'Library', 'Temp', 'build', 'dist', '.venv', 'venv', 'vendor', 'Pods',
  'DerivedData', 'target', 'obj', 'Logs', 'UserSettings', '__pycache__', 'coverage', 'out',
]);

/** Folders under the home directory where code usually lives. */
export const DEFAULT_ROOT_NAMES = [
  'Projects', 'projects', 'code', 'Code', 'src', 'dev', 'Developer', 'repos', 'workspace', path.join('Documents', 'GitHub'),
];

export interface ScanRoot { dir: string; depth: number }

export interface Candidate {
  name: string;
  directory: string;
  /** Newest file mtime found (ms). */
  lastModified: number;
  /** Up to 3 most recently modified files, relative to `directory`, newest first. */
  recentFiles: string[];
}

export interface ScanOptions {
  /** Directories to leave out (already registered). */
  exclude?: string[];
  /** Max project depth below a root. Default 3 (a root's own `depth` wins). */
  maxDepth?: number;
  /** Projects kept. Default 8. */
  limit?: number;
  /** Entries visited per project while looking for recent files. Default 2000. */
  maxEntriesPerProject?: number;
  /** Projects walked in full (the rest are ranked by a cheap top-level check). Default 24. */
  deepWalk?: number;
  /** Overall budget (ms); whatever was found by then is used. Default 4000. */
  budgetMs?: number;
  now?: () => number;
}

const exists = (p: string) => fs.stat(p).then(s => s.isDirectory(), () => false);

/**
 * Explicit roots (depth 3), else the existing default folders under `home` (depth 3), else
 * `home` itself (depth 2).
 */
export async function resolveScanRoots(explicit: string[], home: string = os.homedir()): Promise<ScanRoot[]> {
  const expand = (p: string) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
  if (explicit.length) {
    const dirs = explicit.map(p => path.resolve(expand(p)));
    const ok = await Promise.all(dirs.map(exists));
    return dirs.filter((_, i) => ok[i]).map(dir => ({ dir, depth: 3 }));
  }
  const dirs = DEFAULT_ROOT_NAMES.map(n => path.join(home, n));
  const ok = await Promise.all(dirs.map(exists));
  // Case-insensitive filesystems report both ~/Projects and ~/projects: keep one.
  const seen = new Set<string>();
  const roots: ScanRoot[] = [];
  for (const [i, dir] of dirs.entries()) {
    if (!ok[i]) continue;
    const real = await fs.realpath(dir).catch(() => dir);
    const key = real.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push({ dir, depth: 3 });
  }
  return roots.length ? roots : [{ dir: home, depth: 2 }];
}

const MARKER_FILES = new Set(['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']);

/** True when a directory listing looks like a project root. */
export function isProjectListing(names: string[]): boolean {
  return names.some(n => n === '.git' || MARKER_FILES.has(n) || n === 'ProjectSettings' || n.endsWith('.sln'));
}

const skipDir = (name: string) => name.startsWith('.') || HEAVY_DIRS.has(name);

/** Project directories under the roots (a project's own subfolders are not searched further). */
export async function findProjects(roots: ScanRoot[], opts: { maxDepth?: number; maxDirs?: number; deadline?: number; now?: () => number } = {}): Promise<string[]> {
  const now = opts.now ?? Date.now;
  const maxDirs = opts.maxDirs ?? 20_000;
  const found: string[] = [];
  const seen = new Set<string>();
  let visited = 0;
  // Breadth-first per level, so a deep tree can't starve the shallow ones.
  let level: { dir: string; depth: number; max: number }[] = roots.map(r => ({ dir: r.dir, depth: 0, max: Math.min(r.depth, opts.maxDepth ?? r.depth) }));
  while (level.length) {
    const next: typeof level = [];
    await mapLimit(level, 32, async ({ dir, depth, max }) => {
      if (visited >= maxDirs || (opts.deadline && now() > opts.deadline)) return;
      if (seen.has(dir)) return;
      seen.add(dir);
      visited++;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
      if (!entries) return;
      if (depth > 0 && isProjectListing(entries.map(e => e.name))) {
        found.push(dir);
        return;
      }
      if (depth >= max) return;
      for (const e of entries) {
        if (e.isDirectory() && !skipDir(e.name)) next.push({ dir: path.join(dir, e.name), depth: depth + 1, max });
      }
    });
    level = next;
  }
  return found.sort();
}

/** Cheap recency guess: the newest mtime among the directory, its direct entries and git's index/HEAD log. */
export async function quickMtime(dir: string): Promise<number> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const paths = [dir, path.join(dir, '.git', 'index'), path.join(dir, '.git', 'logs', 'HEAD'),
    ...names.filter(n => !HEAVY_DIRS.has(n) && n !== '.DS_Store').slice(0, 200).map(n => path.join(dir, n))];
  const times = await Promise.all(paths.map(p => fs.stat(p).then(s => s.mtimeMs, () => 0)));
  return Math.max(0, ...times);
}

/** The newest files in a project: a breadth-first walk of at most `maxEntries` entries, skipping heavy and hidden dirs. */
export async function recentFiles(dir: string, maxEntries = 2000, keep = 3): Promise<{ lastModified: number; files: string[] }> {
  const top: { rel: string; mtime: number }[] = [];
  let budget = maxEntries;
  let queue = [dir];
  while (queue.length && budget > 0) {
    const next: string[] = [];
    for (const d of queue) {
      if (budget <= 0) break;
      const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
      const files: string[] = [];
      for (const e of entries) {
        if (budget-- <= 0) break;
        if (e.name.startsWith('.')) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (!HEAVY_DIRS.has(e.name)) next.push(p); }
        else if (e.isFile()) files.push(p);
      }
      const stats = await Promise.all(files.map(p => fs.stat(p).then(s => ({ p, mtime: s.mtimeMs }), () => null)));
      for (const s of stats) {
        if (!s) continue;
        top.push({ rel: path.relative(dir, s.p), mtime: s.mtime });
        top.sort((a, b) => b.mtime - a.mtime);
        if (top.length > keep) top.length = keep;
      }
    }
    queue = next;
  }
  return { lastModified: top[0]?.mtime ?? 0, files: top.map(t => t.rel.split(path.sep).join('/')) };
}

/** Normalise a directory for "already registered" comparisons. */
async function canonical(dir: string): Promise<string> {
  const abs = path.resolve(dir);
  return fs.realpath(abs).catch(() => abs);
}

/** Run `fn` over `items` with at most `n` in flight. */
async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/** Scan the roots and return the most recently edited projects, newest first. */
export async function scanProjects(roots: ScanRoot[], opts: ScanOptions = {}): Promise<Candidate[]> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? 4000);
  const excluded = new Set(await Promise.all((opts.exclude ?? []).map(canonical)));
  const dirs = await findProjects(roots, { maxDepth: opts.maxDepth ?? 3, deadline, now });
  const canon = await Promise.all(dirs.map(canonical));
  const fresh = dirs.filter((_, i) => !excluded.has(canon[i]));

  const quick = await mapLimit(fresh, 16, async d => ({ d, t: await quickMtime(d) }));
  quick.sort((a, b) => b.t - a.t);
  const deep = quick.slice(0, opts.deepWalk ?? 24);
  const walked = await mapLimit(deep, 8, async ({ d, t }) => {
    if (now() > deadline) return { name: path.basename(d), directory: d, lastModified: t, recentFiles: [] };
    const r = await recentFiles(d, opts.maxEntriesPerProject ?? 2000);
    return { name: path.basename(d), directory: d, lastModified: Math.max(r.lastModified, 0) || t, recentFiles: r.files };
  });
  return walked.sort((a, b) => b.lastModified - a.lastModified).slice(0, opts.limit ?? 8);
}

/** First `max` characters of the project's README, if it has one. */
export async function readmeExcerpt(dir: string, max = 400): Promise<string | null> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const readme = names.find(n => /^readme(?:\.(?:md|markdown|txt|rst))?$/i.test(n));
  if (!readme) return null;
  const fh = await fs.open(path.join(dir, readme), 'r').catch(() => null);
  if (!fh) return null;
  try {
    const buf = Buffer.alloc(max * 4);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString('utf-8').replace(/�+$/, '');
    return text.slice(0, max).trim() || null;
  } finally {
    await fh.close();
  }
}

/** "12 min ago", "3 h ago", "2 days ago". */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
