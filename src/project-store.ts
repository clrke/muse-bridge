import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import type { ProjectConfig } from './types.js';

const VACATION_FILE = '.vacation';
/** Per-project folder (inside the project's own directory) for decision notes the agent keeps. */
export const PROJECT_NOTES_DIR = '.muse-bridge';

export class ProjectStore {
  constructor(private dir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async loadAll(): Promise<ProjectConfig[]> {
    const files = await fs.readdir(this.dir).catch(() => [] as string[]);
    const mdFiles = files.filter(f => f.endsWith('.md'));
    const configs = await Promise.all(
      mdFiles.map(file =>
        fs.readFile(path.join(this.dir, file), 'utf-8')
          .then(c => this.parseFrontmatter(c))
          .catch((err) => {
            console.error(`[ProjectStore] Failed to read ${file}: ${(err as Error).message}`);
            return null;
          }),
      ),
    );
    return configs.filter((c): c is ProjectConfig => c !== null);
  }

  async load(slug: string): Promise<ProjectConfig | null> {
    try {
      const content = await fs.readFile(path.join(this.dir, `${slug}.md`), 'utf-8');
      return this.parseFrontmatter(content);
    } catch {
      return null;
    }
  }

  async save(project: ProjectConfig): Promise<void> {
    const filePath = path.join(this.dir, `${project.slug}.md`);
    const tmpPath = `${filePath}.tmp`;
    const content = `---\n${yaml.dump(project, { lineWidth: -1 })}---\n`;
    // Write to temp file then rename: atomic on POSIX, prevents partial writes
    // and last-write-wins corruption when two saves race for the same slug
    await fs.writeFile(tmpPath, content, 'utf-8');
    await fs.rename(tmpPath, filePath);
  }

  async create(data: Omit<ProjectConfig, 'sessionId' | 'status' | 'decision' | 'createdAt'>): Promise<ProjectConfig> {
    const project: ProjectConfig = {
      ...data,
      sessionId: null,
      status: 'Awaiting first message',
      decision: null,
      createdAt: new Date().toISOString(),
    };
    await this.save(project);
    await this.ensureGitignore(data.directory);
    await this.ensureNotesDir(data.directory);
    return project;
  }

  async getSlugs(): Promise<string[]> {
    const files = await fs.readdir(this.dir).catch(() => [] as string[]);
    return files.filter(f => f.endsWith('.md')).map(f => f.slice(0, -3));
  }

  async isVacation(): Promise<boolean> {
    try {
      await fs.access(path.join(this.dir, VACATION_FILE));
      return true;
    } catch {
      return false;
    }
  }

  async setVacation(active: boolean): Promise<void> {
    const file = path.join(this.dir, VACATION_FILE);
    if (active) {
      await fs.writeFile(file, new Date().toISOString(), 'utf-8');
    } else {
      await fs.unlink(file).catch(() => {});
    }
  }

  private parseFrontmatter(content: string): ProjectConfig | null {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;
    try {
      return yaml.load(match[1]) as ProjectConfig;
    } catch {
      return null;
    }
  }

  private async ensureGitignore(projectDir: string): Promise<void> {
    const gitignorePath = path.join(projectDir, '.gitignore');
    const entry = `${PROJECT_NOTES_DIR}/`;
    // Read existing content; create file if absent
    const existing = await fs.readFile(gitignorePath, 'utf-8').catch(() => '');
    if (existing.split('\n').some(line => line.trim() === entry.trim())) return;
    // Append only — avoids full-file rewrite race; trailing newline added if needed
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    await fs.appendFile(gitignorePath, `${prefix}${entry}\n`, 'utf-8');
  }

  private async ensureNotesDir(projectDir: string): Promise<void> {
    await fs.mkdir(path.join(projectDir, PROJECT_NOTES_DIR), { recursive: true });
  }
}
