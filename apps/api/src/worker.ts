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
  private readonly pendingCancellations = new Set<string>();
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
      for (const session of await this.store.listRecoverableQueued()) {
        // Queued sessions may contain successfully completed steps from an earlier
        // approved manual resume. They are safe if no unapproved intent remains.
        if (!uncertainDebateEntries(session).length &&
            (!session.consensus || !!session.recovery) &&
            ![...(session.consensus?.callJournal ?? []), ...(session.consensus?.negotiationCalls ?? [])]
              .some(call => call.status === 'issued' && !call.retryAuthorized)) {
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
    if (this.runningId === id) { this.pendingCancellations.add(id); return 'cancelling'; }
    return await this.store.get(id) ? 'inactive' : 'missing';
  }
  /** No ambiguous external call is automatically repeated after restart.
   * The caller must explicitly name EVERY uncertain call ID and acknowledge the risk
   * of provider charge duplication if the prior call had reached the remote service.
   */
  /** Explicit recovery is permitted only when every possibly invoked call can
   * be identified. Old pre-M5.2 consensus states without a journal fail closed.
   */
  async resume(
    id: string, retryIds: string[] = [], acknowledgeMayRepeatCall = false,
  ): Promise<{ status: 'queued'; id: string } | { status: 'conflict'; reason: string; uncertainCallIds?: string[] } | null> {
    const conflict = (reason: string, uncertainCallIds: string[] = []) =>
      ({ status: 'conflict' as const, reason, uncertainCallIds });
    if (this.runningId === id || this.pending.includes(id)) return conflict('Session is already scheduled.');
    const session = await this.store.getPersisted(id);
    if (!session) return null;
    const consensus = session.consensus;
    const recoverConsensus = !!consensus &&
      consensus.status !== 'not_assessed' &&
      (session.debateStatus === 'completed' || session.status === 'completed');
    const recoverPartialDebate = session.status === 'partial' &&
      (!consensus || consensus.status === 'not_assessed');
    if (!['running', 'interrupted', 'queued'].includes(session.status) &&
        !recoverConsensus && !recoverPartialDebate) {
      return conflict('Only interrupted work, unfinished consensus, or an explicitly retried partial debate can resume. Finished verified outcomes are immutable.');
    }
    if (consensus && ['unanimous', 'qualified', 'disputed', 'blocked', 'blocked_by_unparseable_evidence'].includes(consensus.status) &&
        !['running', 'interrupted', 'queued'].includes(session.status)) {
      return conflict('The recorded consensus decision is final. Create a new debate to re-evaluate it.');
    }
    // Pre-M4.2 stored work might lack a persisted deadline. Derive one
    // conservatively from creation time; do not grant a fresh full budget.
    if (!session.executionDeadlineAt) {
      const created = Date.parse(session.createdAt);
      if (Number.isFinite(created)) {
        session.executionDeadlineAt = new Date(created + (session.request.maxDurationMs ?? 900000)).toISOString();
      }
    }
    const deadline = Date.parse(session.executionDeadlineAt ?? '');
    if (!Number.isFinite(deadline) || deadline <= Date.now()) {
      return conflict('The original session deadline has expired; resuming cannot extend it. Start a new run.');
    }
    if (session.calls >= (session.request.maxCalls ?? 40)) return conflict('The original model-call budget has been exhausted.');
    const debateCalls = uncertainDebateEntries(session);
    const ledger = [...(consensus?.callJournal ?? []), ...(consensus?.negotiationCalls ?? [])];
    const unknown = ledger.filter(c => c.status === 'issued' && !c.retryAuthorized);
    const rejected = ledger.filter(c => c.status === 'rejected' && !c.retryAuthorized);
    if (consensus && consensus.status !== 'not_assessed' && !consensus.callJournal?.length &&
        (consensus.draft || consensus.votes.length) &&
        !consensus.negotiationHistory?.length) {
      return conflict('Legacy consensus has no call journal. Its in-flight provider calls cannot be reconstructed safely.');
    }
    if (consensus?.negotiationHistory?.some(c =>
      (c.outcome === 'running' || c.outcome === 'interrupted') &&
      (c.revisions.length > 0 || !!c.revisedDraftSha256)) &&
      !consensus.negotiationCalls?.length) {
      return conflict('Negotiation has progressed but lacks a durable provider-call journal; unsafe to resume.');
    }
    const failedDebate = session.entries.filter(e => (e.status === 'rejected' || e.status === 'skipped') && !e.retryAuthorized);
    const requested = new Set(retryIds);
    const candidates = [...debateCalls, ...failedDebate, ...unknown, ...rejected];
    const candidateIds = new Set(candidates.map(e => e.id));
    const requiredRejected = rejected.filter(item => {
      if ('stage' in item) {
        if (item.stage === 'synthesis') return !consensus?.draft?.sha256;
        if (item.stage === 'vote') return !consensus?.votes.some(v =>
          v.provider === item.provider && v.status === 'fulfilled' &&
          v.draftSha256 === (item as import('../../../packages/core/src/consensus.ts').ConsensusCall).frozenDraftSha256);
        return false; // A failed optional clarification/resolution is not a mandatory checkpoint.
      }
      const cycle = consensus?.negotiationHistory?.find(c => c.number === item.cycle);
      if (item.role === 'targeted_revision') return !cycle?.revisions.some(r =>
        r.provider === item.provider && r.status === 'fulfilled');
      if (item.role === 're_synthesis') return !cycle?.revisedDraftSha256;
      if (item.role === 're_vote') return !consensus?.votes.some(v =>
        v.provider === item.provider && v.status === 'fulfilled' &&
        v.draftSha256 === cycle?.revisedDraftSha256);
      return false;
    });
    const mandatory = [...debateCalls, ...unknown, ...requiredRejected];
    if (mandatory.some(e => !requested.has(e.id))) {
      return conflict('Uncertain or unresolved failed provider calls need exact IDs and explicit duplicate-charge authorization.',
        mandatory.map(e => e.id));
    }
    if ([...requested].some(id => !candidateIds.has(id))) {
      return conflict('A retry ID does not identify a pending, rejected, or uncertain call.');
    }
    if (requested.size && !acknowledgeMayRepeatCall) {
      return conflict('Explicitly acknowledge possible repeated provider calls and list their IDs.', [...requested]);
    }
    if (recoverPartialDebate && ![...requested].some(id => failedDebate.some(e => e.id === id))) {
      return conflict('Partial debate recovery requires explicit retry of at least one failed or skipped stage.',
        failedDebate.map(e => e.id));
    }
    if (session.calls + requested.size > (session.request.maxCalls ?? 40)) {
      return conflict('Not enough model-call budget to cover requested repeats.');
    }
    // Replaying a critique after the rebuttal/revision already ran would require
    // invalidating downstream evidence and author sign-offs: never do this silently.
    for (const entry of failedDebate.filter(e => requested.has(e.id))) {
      const dependent = session.entries.some(e => e.status === 'fulfilled' &&
        (entry.phase === 'proposal' && ['critique', 'rebuttal', 'revision'].includes(e.phase) ||
        entry.phase === 'critique' && e.round >= entry.round && ['rebuttal', 'revision'].includes(e.phase) ||
        entry.phase === 'rebuttal' && e.provider === entry.provider && e.round >= entry.round && e.phase === 'revision' ||
        entry.phase === 'revision' && e.round > entry.round));
      if (dependent) return conflict('Failed stage has successful downstream work. Replaying would invalidate evidence; start a new run.');
    }
    for (const item of candidates) {
      if (requested.has(item.id)) item.retryAuthorized = true;
    }
    if (recoverConsensus && !consensus?.callJournal?.length && !consensus?.negotiationCalls?.length && consensus?.draft) {
      return conflict('Consensus has no recoverable journaled calls.');
    }
    if (recoverConsensus && !consensus?.draft && !consensus?.callJournal?.length) {
      return conflict('Initial synthesis was not journaled; cannot prove whether a call was charged.');
    }
    session.recovery = {
      attempts: (session.recovery?.attempts ?? 0) + 1,
      kind: recoverConsensus ? 'consensus' : 'debate',
      at: new Date().toISOString(), authorizedCallIds: [...requested],
    };
    this.counters.uncertain += mandatory.filter(e => requested.has(e.id)).length;
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
      this.pendingCancellations.delete(id);
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
    if (this.pendingCancellations.has(id)) controller.abort();
    this.counters.started++;
    try {
      await executeDebate(session, this.adapters, this.publish, controller.signal);
      const finalStatus = session.status as DebateSession['status'];
      if (finalStatus === 'completed') this.counters.completed++;
      else if (finalStatus === 'cancelled') this.counters.cancelled++;
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
    if (this.runningId) this.pendingCancellations.add(this.runningId);
    for (const controller of this.controllers.values()) controller.abort();
    // Queued sessions remain durable for the next process; do not rewrite them.
    if (this.runPromise) await this.runPromise;
    for (const id of this.pending) this.store.deactivate(id);
    this.pending.length = 0;
    if (this.releaseLease) await this.releaseLease();
    this.releaseLease = null;
  }
}
