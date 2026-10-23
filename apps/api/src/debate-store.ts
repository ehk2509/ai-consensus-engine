import { mkdir, readFile, readdir, rename, writeFile, rm, stat } from 'node:fs/promises';
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
  getDirectory(): string { return this.directory; }
  /** A single writer process owns this directory. mkdir is atomic across processes. */
  async acquireWorkerLease(): Promise<() => Promise<void>> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, '.worker-lock');
    const owner = join(lock, 'owner.json');
    const token = randomUUID();
    const take = async () => {
      await mkdir(lock);
      await writeFile(owner, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }),
        { mode: 0o600 });
    };
    try { await take(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let pid: number | undefined;
      try {
        const value = JSON.parse(await readFile(owner, 'utf8')) as { pid?: number };
        pid = value.pid;
      } catch {
        const age = await stat(lock).then(info => Date.now() - info.mtimeMs).catch(() => 0);
        if (age < 30000) throw new Error('Worker lease is being initialized by another process.');
      }
      if (pid && Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); throw new Error('Another active worker owns this data directory.'); }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
        }
      }
      await rm(lock, { recursive: true, force: true });
      await take();
    }
    return async () => {
      try {
        const value = JSON.parse(await readFile(owner, 'utf8')) as { token: string };
        if (value.token === token) await rm(lock, { recursive: true, force: true });
      } catch { /* Lease was already released or replaced. */ }
    };
  }
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
  /** Read exactly what was durably committed; do not silently mutate the stored status. */
  async getPersisted(id: string): Promise<DebateSession | null> {
    if (!ID_PATTERN.test(id)) return null;
    await this.writes.get(id);
    try { return JSON.parse(await readFile(this.filename(id), 'utf8')) as DebateSession; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async get(id: string): Promise<DebateSession | null> {
    const value = await this.getPersisted(id);
    if (!value) return null;
    if ((value.status === 'running' || value.status === 'queued') && !this.active.has(id)) {
      return { ...value, status: 'interrupted', phase: null,
        error: 'Server stopped before this run completed. Resume is available after verifying uncertain calls.' };
    }
    return value;
  }
  async listPersisted(limit = 500): Promise<DebateSession[]> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const sessions = await Promise.all(names.filter(name => name.endsWith('.json') && ID_PATTERN.test(name.slice(0, -5)))
      .map(name => this.getPersisted(name.slice(0, -5))));
    return sessions.filter((v): v is DebateSession => v !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.max(1, Math.min(1000, limit)));
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
