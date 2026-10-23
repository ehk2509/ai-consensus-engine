import { DebateStore } from './debate-store.ts';
import { executeDebate, uncertainDebateEntries } from '../../../packages/core/src/debate.ts';
import type { DebateSession } from '../../../packages/core/src/debate.ts';
import type { AgentAdapter } from '../../../packages/core/src/types.ts';

export interface WorkerCounters {
  started: number; completed: number; failed: number; cancelled: number; recoveredQueued: number;
  uncertain: number;
}
export class DurableDebateWorker {
  private readonly pending: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private runningId: string | null = null;
  private runPromise: Promise<void> | null = null;
  private releaseLease: (() => Promise<void>) | null = null;
  private stopped = false;
  private readonly store: DebateStore;
  private readonly adapters: ReadonlyMap<string, AgentAdapter>;
  private readonly publish: (session: DebateSession) => Promise<void>;
  private readonly logError: (error: unknown, message: string) => void;
  readonly counters: WorkerCounters = {
    started: 0, completed: 0, failed: 0, cancelled: 0, recoveredQueued: 0, uncertain: 0,
  };
  constructor(
    store: DebateStore,
    adapters: ReadonlyMap<string, AgentAdapter>,
    publish: (session: DebateSession) => Promise<void>,
    logError: (error: unknown, message: string) => void,
  ) {
    this.store = store; this.adapters = adapters; this.publish = publish; this.logError = logError;
  }

  get queued(): number { return this.pending.length; }
  get running(): string | null { return this.runningId; }
  get busy(): boolean { return !!this.runningId || this.pending.length > 0; }
  async start(): Promise<void> {
    this.releaseLease = await this.store.acquireWorkerLease();
    try {
      // Only never-issued queued work is auto-recovered. A crashed running call
      // stays interrupted until an explicit operator decision.
      for (const session of await this.store.listPersisted(1000)) {
        if (session.status === 'queued' && session.entries.length === 0 && !session.consensus) {
          this.store.activate(session.id);
          this.pending.push(session.id);
          this.counters.recoveredQueued++;
        }
      }
      this.kick();
    } catch (error) {
      await this.releaseLease();
      this.releaseLease = null;
      throw error;
    }
  }
  async enqueue(session: DebateSession): Promise<void> {
    if (this.stopped) throw new Error('Debate worker is shutting down.');
    if (this.pending.includes(session.id) || this.runningId === session.id) throw new Error('Session is already scheduled.');
    // Persist before exposing work to the worker.
    await this.store.save(session);
    this.store.activate(session.id);
    this.pending.push(session.id);
    this.kick();
  }
  async cancel(id: string): Promise<'cancelling' | 'cancelled' | 'missing' | 'inactive'> {
    const queuedIndex = this.pending.indexOf(id);
    if (queuedIndex >= 0) {
      this.pending.splice(queuedIndex, 1);
      const session = await this.store.getPersisted(id);
      if (!session) return 'missing';
      session.status = 'cancelled';
      session.phase = null;
      session.finishedAt = new Date().toISOString();
      session.error = 'Cancelled before any provider call.';
      await this.publish(session);
      this.store.deactivate(id);
      return 'cancelled';
    }
    const controller = this.controllers.get(id);
    if (controller) { controller.abort(); return 'cancelling'; }
    return await this.store.get(id) ? 'inactive' : 'missing';
  }
  /** No ambiguous external call is automatically repeated after restart.
   * The caller must explicitly name EVERY uncertain call ID and acknowledge the risk
   * of provider charge duplication if the prior call had reached the remote service.
   */
  async resume(
    id: string, retryIds: string[] = [], acknowledgeMayRepeatCall = false,
  ): Promise<{ status: 'queued'; id: string } | { status: 'conflict'; reason: string; uncertainCallIds?: string[] } | null> {
    if (this.runningId === id || this.pending.includes(id)) return { status: 'conflict', reason: 'Session is already scheduled.' };
    const session = await this.store.getPersisted(id);
    if (!session) return null;
    if (!['running', 'interrupted', 'queued'].includes(session.status)) {
      return { status: 'conflict', reason: 'Only interrupted or pending sessions can resume. Finished sessions are immutable.' };
    }
    if (session.consensus) {
      return { status: 'conflict', reason: 'A crashed consensus-stage call cannot yet be safely reconstructed; create a new run. No model call was replayed.' };
    }
    const uncertain = uncertainDebateEntries(session);
    const requested = new Set(retryIds);
    if (uncertain.length) {
      if (!acknowledgeMayRepeatCall || uncertain.some(entry => !requested.has(entry.id)) ||
          [...requested].some(key => !uncertain.some(entry => entry.id === key))) {
        return {
          status: 'conflict', reason: 'External call outcome is unknown. Explicitly acknowledge potential duplicate billing and list all uncertain call IDs.',
          uncertainCallIds: uncertain.map(entry => entry.id),
        };
      }
      if (session.calls + uncertain.length > (session.request.maxCalls ?? 40)) {
        return { status: 'conflict', reason: 'Call budget cannot cover explicitly authorized repeats.' };
      }
      for (const entry of uncertain) {
        entry.status = 'uncertain';
        entry.retryAuthorized = true;
        entry.error = 'Outcome unknown; operator explicitly authorized a new call that may duplicate earlier provider usage.';
      }
      this.counters.uncertain += uncertain.length;
    } else if (retryIds.length || acknowledgeMayRepeatCall) {
      return { status: 'conflict', reason: 'No uncertain calls exist to retry.' };
    }
    session.status = 'queued';
    session.phase = null;
    session.finishedAt = undefined;
    session.error = undefined;
    await this.enqueue(session);
    return { status: 'queued', id };
  }
  private kick(): void {
    if (this.stopped || this.runningId || !this.pending.length) return;
    const id = this.pending.shift()!;
    this.runningId = id;
    this.runPromise = this.execute(id).catch(error => {
      this.counters.failed++;
      this.logError(error, 'Durable worker could not load queued session');
    }).finally(() => {
      this.controllers.delete(id);
      this.store.deactivate(id);
      this.runningId = null;
      this.runPromise = null;
      this.kick();
    });
  }
  private async execute(id: string): Promise<void> {
    const session = await this.store.getPersisted(id);
    if (!session || session.status !== 'queued') return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.counters.started++;
    try {
      await executeDebate(session, this.adapters, this.publish, controller.signal);
      if (session.status === 'completed') this.counters.completed++;
      else if (session.status === 'cancelled') this.counters.cancelled++;
      else this.counters.failed++;
    } catch (error) {
      this.counters.failed++;
      this.logError(error, 'Debate worker encountered a failure');
      session.status = 'failed';
      session.phase = null;
      session.finishedAt = new Date().toISOString();
      session.error = 'Unexpected worker failure. Durable records and uncertain calls remain available.';
      try { await this.publish(session); }
      catch (writeError) { this.logError(writeError, 'Could not persist worker failure'); }
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const controller of this.controllers.values()) controller.abort();
    // Queued sessions remain durable for the next process; do not rewrite them.
    if (this.runPromise) await this.runPromise;
    for (const id of this.pending) this.store.deactivate(id);
    this.pending.length = 0;
    if (this.releaseLease) await this.releaseLease();
    this.releaseLease = null;
  }
}
