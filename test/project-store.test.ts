import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../src/project-store.js';

describe('ProjectStore', () => {
  let tmpDir: string;
  let projectDir: string;
  let store: ProjectStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'proj-store-'));
    projectDir = path.join(tmpDir, 'fake-project');
    await fs.mkdir(projectDir, { recursive: true });
    store = new ProjectStore(path.join(tmpDir, '.projects'));
    await store.init();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  it('creates and loads a project', async () => {
    const project = await store.create({
      title: 'Test Project',
      slug: 'test',
      description: 'A test',
      directory: projectDir,
      autoDecide: true,
    });
    expect(project.slug).toBe('test');
    expect(project.sessionId).toBeNull();
    expect(project.status).toBe('Awaiting first message');

    const loaded = await store.load('test');
    expect(loaded?.title).toBe('Test Project');
  });

  it('returns null for nonexistent project', async () => {
    const loaded = await store.load('nonexistent');
    expect(loaded).toBeNull();
  });

  it('appends to .gitignore', async () => {
    await store.create({
      title: 'Test', slug: 'test', description: 'x',
      directory: projectDir, autoDecide: true,
    });
    const gitignore = await fs.readFile(path.join(projectDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.muse-bridge/');
  });

  it('does not duplicate .gitignore entry', async () => {
    await fs.writeFile(path.join(projectDir, '.gitignore'), '.muse-bridge/\n');
    await store.create({
      title: 'Test', slug: 'test', description: 'x',
      directory: projectDir, autoDecide: true,
    });
    const gitignore = await fs.readFile(path.join(projectDir, '.gitignore'), 'utf-8');
    const count = gitignore.split('.muse-bridge/').length - 1;
    expect(count).toBe(1);
  });

  it('creates .muse-bridge dir', async () => {
    await store.create({
      title: 'Test', slug: 'test', description: 'x',
      directory: projectDir, autoDecide: true,
    });
    const stat = await fs.stat(path.join(projectDir, '.muse-bridge'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('lists all slugs', async () => {
    await store.create({ title: 'A', slug: 'alpha', description: 'x', directory: projectDir, autoDecide: true });
    await store.create({ title: 'B', slug: 'beta', description: 'x', directory: projectDir, autoDecide: true });
    const slugs = await store.getSlugs();
    expect(slugs).toContain('alpha');
    expect(slugs).toContain('beta');
  });

  it('manages vacation state', async () => {
    expect(await store.isVacation()).toBe(false);
    await store.setVacation(true);
    expect(await store.isVacation()).toBe(true);
    await store.setVacation(false);
    expect(await store.isVacation()).toBe(false);
  });

  it('saves and loads decision state', async () => {
    const project = await store.create({
      title: 'Test', slug: 'test', description: 'x',
      directory: projectDir, autoDecide: true,
    });
    project.decision = {
      summary: 'Which DB?',
      rating: 5,
      deadline: '2026-03-25T12:00:00',
      pausedRemaining: null,
    };
    project.status = 'awaiting-decision';
    await store.save(project);

    const loaded = await store.load('test');
    expect(loaded?.decision?.summary).toBe('Which DB?');
    expect(loaded?.decision?.rating).toBe(5);
    expect(loaded?.status).toBe('awaiting-decision');
  });

  it('loadAll returns all projects', async () => {
    await store.create({ title: 'A', slug: 'a', description: 'x', directory: projectDir, autoDecide: true });
    await store.create({ title: 'B', slug: 'b', description: 'y', directory: projectDir, autoDecide: false });
    const all = await store.loadAll();
    expect(all).toHaveLength(2);
    expect(all.map(p => p.slug).sort()).toEqual(['a', 'b']);
  });

  it('atomic save leaves no .tmp file behind', async () => {
    const project = await store.create({
      title: 'Test', slug: 'test', description: 'x',
      directory: projectDir, autoDecide: true,
    });
    project.status = 'updated';
    await store.save(project);

    const files = await fs.readdir(path.join(tmpDir, '.projects'));
    expect(files.some(f => f.endsWith('.tmp'))).toBe(false);
    expect(files).toContain('test.md');
  });

  it('appends to .gitignore without trailing newline', async () => {
    // File exists but lacks trailing newline — append should still produce valid output
    await fs.writeFile(path.join(projectDir, '.gitignore'), 'node_modules');
    await store.create({
      title: 'Test', slug: 'test', description: 'x',
      directory: projectDir, autoDecide: true,
    });
    const content = await fs.readFile(path.join(projectDir, '.gitignore'), 'utf-8');
    expect(content).toContain('\n.muse-bridge/');
    expect(content.split('.muse-bridge/').length - 1).toBe(1);
  });

  it('does not duplicate .gitignore entry on re-create', async () => {
    // Simulate two sequential creates (e.g. re-registration)
    const opts = { title: 'Test', slug: 'test', description: 'x', directory: projectDir, autoDecide: true };
    await store.create(opts);
    await store.create({ ...opts, slug: 'test2' }); // different slug, same dir
    const content = await fs.readFile(path.join(projectDir, '.gitignore'), 'utf-8');
    expect(content.split('.muse-bridge/').length - 1).toBe(1);
  });
});
