import Fastify from 'fastify';
import { brainstorm, validateRequest } from '../../../packages/core/src/brainstorm.ts';
import { createDebateSession, validateDebateRequest } from '../../../packages/core/src/debate.ts';
import type { DebateSession } from '../../../packages/core/src/debate.ts';
import { PROVIDER_IDS } from '../../../packages/core/src/types.ts';
import type { AgentAdapter } from '../../../packages/core/src/types.ts';
import { createAdapters, probeInstalledClis } from './providers.ts';
import { DebateStore } from './debate-store.ts';
import { DurableDebateWorker } from './worker.ts';
import { installLocalAuth } from './auth.ts';
import { DailyCallQuota, environmentQuotaLimits } from './quota.ts';
import type { DailyQuotaLimits } from './quota.ts';

export interface AppOptions { adapters?: Map<string, AgentAdapter>; store?: DebateStore; apiToken?: string; quotaLimits?: DailyQuotaLimits; allowUnauthenticatedForTests?: boolean; }

export function makeApp(options: AppOptions = {}) {
  if (!(options.apiToken ?? process.env.ACE_API_TOKEN) && !options.allowUnauthenticatedForTests) {
    throw new Error('API access token is mandatory. Only tests may explicitly opt out.');
  }
  const app = Fastify({ logger: true, bodyLimit: 4 * 1024 * 1024 });
  const baseAdapters = options.adapters ?? createAdapters();
  const store = options.store ?? new DebateStore(process.env.ACE_DATA_DIR);
  const quota = new DailyCallQuota(store.getDirectory(), options.quotaLimits ?? environmentQuotaLimits(process.env));
  const adapters = new Map<string, AgentAdapter>([...baseAdapters].map(([name, adapter]) => [name, {
    id: adapter.id,
    propose: async (prompt, signal, config) => {
      await quota.reserve(adapter.id);
      return adapter.propose(prompt, signal, config);
    },
  }]));
  const listeners = new Map<string, Set<(session: DebateSession) => void>>();
  let brainstorming = false;
  const broadcast = (session: DebateSession) => {
    for (const listener of listeners.get(session.id) ?? []) listener(session);
  };
  const publish = async (session: DebateSession) => { await store.save(session); broadcast(session); };
  const worker = new DurableDebateWorker(
    store, adapters, publish, (error, message) => app.log.error({ err: error }, message),
  );
  installLocalAuth(app, options.apiToken ?? process.env.ACE_API_TOKEN);
  app.addHook('onReady', async () => { await worker.start(); });
  app.addHook('onClose', async () => { await worker.stop(); });

  app.get('/api/health', async () => ({ status: 'ok', version: '0.5.5', milestone: 'M5.5' }));
  app.get('/api/metrics', async () => ({
    status: 'ok', worker: { running: !!worker.running, queued: worker.queued },
    calls: worker.counters, dailyQuota: await quota.snapshot(),
  }));
  app.get('/api/providers', async () => {
    const probes = await probeInstalledClis();
    return {
      providers: PROVIDER_IDS.map((id) => ({
        id, configured: adapters.has(id), installed: probes.find((probe) => probe.id === id)?.installed ?? false,
      })),
      note: 'Installed checks --version only, not authentication or usage quota.',
    };
  });

  app.post('/api/brainstorms', async (request, reply) => {
    let input;
    try { input = validateRequest(request.body); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid request.' }); }
    if (brainstorming || worker.busy) return reply.code(409).send({ error: 'A debate worker is busy.' });
    brainstorming = true;
    try { return await brainstorm(input, adapters); }
    finally { brainstorming = false; }
  });

  app.post('/api/debates', async (request, reply) => {
    let input;
    try { input = validateDebateRequest(request.body); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid request.' }); }
    if (brainstorming) return reply.code(409).send({ error: 'Independent proposal session is running.' });
    const session = createDebateSession(input);
    try { await worker.enqueue(session); }
    catch (error) {
      app.log.error({ err: error }, 'Unable to queue debate');
      return reply.code(500).send({ error: 'Unable to durably queue this debate.' });
    }
    return reply.code(202).send({ id: session.id, status: 'queued', queued: worker.queued });
  });

  app.post<{ Params: { id: string } }>('/api/debates/:id/cancel', async (request, reply) => {
    const outcome = await worker.cancel(request.params.id);
    if (outcome === 'missing') return reply.code(404).send({ error: 'Session not found.' });
    if (outcome === 'inactive') return reply.code(409).send({ error: 'Session is not currently queued or running.' });
    return reply.code(202).send({ status: outcome, id: request.params.id });
  });

  app.post<{ Params: { id: string }; Body: { retryCallIds?: string[]; acknowledgeMayRepeatCall?: boolean } }>('/api/debates/:id/resume', async (request, reply) => {
    const body = request.body ?? {};
    if ((body.retryCallIds !== undefined && (!Array.isArray(body.retryCallIds) ||
      body.retryCallIds.length > 40 || body.retryCallIds.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)))) ||
      (body.acknowledgeMayRepeatCall !== undefined && typeof body.acknowledgeMayRepeatCall !== 'boolean')) {
      return reply.code(400).send({ error: 'Invalid explicit retry authorization.' });
    }
    const result = await worker.resume(request.params.id, body.retryCallIds, body.acknowledgeMayRepeatCall);
    if (!result) return reply.code(404).send({ error: 'Session not found.' });
    if (result.status === 'conflict') return reply.code(409).send({
      error: result.reason, uncertainCallIds: result.uncertainCallIds ?? [],
    });
    return reply.code(202).send(result);
  });

  app.get<{ Params: { id: string } }>('/api/debates/:id/report', async (request, reply) => {
    const session = await store.get(request.params.id);
    if (!session) return reply.code(404).send({ error: 'Session not found.' });
    if (!session.consensus?.reportMarkdown) return reply.code(409).send({ error: 'No complete consensus report is available for this session.' });
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="consensus-${session.id}.md"`);
    return session.consensus.reportMarkdown;
  });

  app.get('/api/debates', async () => {
    const sessions = await store.list(30);
    return { sessions: sessions.map(({ id, request, createdAt, updatedAt, status, round }) =>
      ({ id, prompt: request.prompt, providers: request.providers, maxRounds: request.maxRounds, createdAt, updatedAt, status, round })) };
  });

  app.get<{ Params: { id: string } }>('/api/debates/:id', async (request, reply) => {
    const session = await store.get(request.params.id);
    if (!session) return reply.code(404).send({ error: 'Session not found.' });
    reply.header('Cache-Control', 'no-store');
    return session;
  });

  app.get<{ Params: { id: string } }>('/api/debates/:id/events', async (request, reply) => {
    const initial = await store.get(request.params.id);
    if (!initial) return reply.code(404).send({ error: 'Session not found.' });
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    let closed = false;
    let lastSequence = -1;
    const listenerSet = listeners.get(initial.id) ?? new Set<(session: DebateSession) => void>();
    listeners.set(initial.id, listenerSet);
    const cleanup = (finish = false) => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      listenerSet.delete(signal);
      if (listenerSet.size === 0) listeners.delete(initial.id);
      if (finish && !reply.raw.destroyed) reply.raw.end();
    };
    const signal = (value: DebateSession) => {
      if (closed || value.events.length <= lastSequence) return;
      lastSequence = value.events.length;
      reply.raw.write('id: ' + lastSequence + '\nevent: update\ndata: ' + JSON.stringify({
        id: value.id, status: value.status, phase: value.phase, round: value.round,
        sequence: lastSequence, updatedAt: value.updatedAt,
      }) + '\n\n');
      if (!['queued', 'running'].includes(value.status)) cleanup(true);
    };
    const heartbeat = setInterval(() => { if (!closed) reply.raw.write(': keepalive\n\n'); }, 20000);
    reply.raw.on('close', () => cleanup());
    listenerSet.add(signal);
    // Register FIRST, then reload the latest durable state. Sequence prevents backwards notifications.
    // Finishing during this interval is handled by the live listener and by this snapshot.
    try {
      const latest = await store.get(initial.id);
      if (latest) signal(latest);
      else cleanup(true);
    } catch (error) {
      app.log.error({ err: error }, 'Unable to stream debate state');
      cleanup(true);
    }
  });

  return app;
}
