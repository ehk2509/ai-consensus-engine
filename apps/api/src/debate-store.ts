import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { durableReplace } from './durable-json.ts';
import { acquireLocalWorkerLease } from './worker-lease.ts';
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
  /** The kernel lock stays owned by the helper as long as its parent holds stdin. */
  async acquireWorkerLease(): Promise<() => Promise<void>> {
    return acquireLocalWorkerLease(this.directory);
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
    const next = previous.catch(() => {}).then(() => durableReplace(this.filename(id), snapshot));
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
  /** Scan every stored job: historical completed sessions must never hide new queued work. */
  async listRecoverableQueued(): Promise<DebateSession[]> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const queued: DebateSession[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || !ID_PATTERN.test(name.slice(0, -5))) continue;
      const session = await this.getPersisted(name.slice(0, -5));
      if (session?.status === 'queued') queued.push(session);
    }
    queued.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return queued;
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
