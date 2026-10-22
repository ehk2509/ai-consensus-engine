import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DebateSession } from '../../../packages/core/src/debate.ts';

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DebateStore {
  private writes = new Map<string, Promise<void>>();
  private active = new Set<string>();
  private readonly directory: string;
  constructor(directory = resolve(process.cwd(), '.ace-data', 'debates')) { this.directory = resolve(directory); }
  activate(id: string) { this.active.add(id); }
  deactivate(id: string) { this.active.delete(id); }
  private filename(id: string) {
    if (!ID_PATTERN.test(id)) throw new Error('Invalid session ID.');
    return join(this.directory, id + '.json');
  }
  /** Queue immutable snapshots to prevent an older provider completion overwriting a newer one. */
  async save(session: DebateSession): Promise<void> {
    const snapshot = JSON.stringify(session);
    const id = session.id;
    const previous = this.writes.get(id) ?? Promise.resolve();
    const next = previous.catch(() => { /* A failed write must not poison later snapshots. */ }).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const tmp = this.filename(id) + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 });
        await rename(tmp, this.filename(id));
      } catch (error) {
        const { rm } = await import('node:fs/promises');
        await rm(tmp, { force: true });
        throw error;
      }
    });
    this.writes.set(id, next);
    try { await next; }
    finally { if (this.writes.get(id) === next) this.writes.delete(id); }
  }
  async get(id: string): Promise<DebateSession | null> {
    if (!ID_PATTERN.test(id)) return null;
    await this.writes.get(id);
    try {
      const value = JSON.parse(await readFile(this.filename(id), 'utf8')) as DebateSession;
      if ((value.status === 'running' || value.status === 'queued') && !this.active.has(id)) {
        return { ...value, status: 'interrupted', phase: null, error: 'Server stopped before the debate completed. This session is read-only.' };
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async list(limit = 30): Promise<DebateSession[]> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const sessions = await Promise.all(names.filter((name) => name.endsWith('.json') && ID_PATTERN.test(name.slice(0, -5)))
      .map((name) => this.get(name.slice(0, -5))));
    return sessions.filter((session): session is DebateSession => session !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(100, limit)));
  }
}
