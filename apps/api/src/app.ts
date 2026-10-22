import Fastify from 'fastify';
import { brainstorm, validateRequest } from '../../../packages/core/src/brainstorm.ts';
import { createDebateSession, executeDebate, validateDebateRequest } from '../../../packages/core/src/debate.ts';
import type { DebateSession } from '../../../packages/core/src/debate.ts';
import { PROVIDER_IDS } from '../../../packages/core/src/types.ts';
import type { AgentAdapter } from '../../../packages/core/src/types.ts';
import { createAdapters, probeInstalledClis } from './providers.ts';
import { DebateStore } from './debate-store.ts';

export interface AppOptions { adapters?: Map<string, AgentAdapter>; store?: DebateStore; }

export function makeApp(options: AppOptions = {}) {
  const app = Fastify({ logger: true, bodyLimit: 16 * 1024 });
  const adapters = options.adapters ?? createAdapters();
  const store = options.store ?? new DebateStore(process.env.ACE_DATA_DIR);
  const listeners = new Map<string, Set<(session: DebateSession) => void>>();
  const controllers = new Map<string, AbortController>();
  let busy = false;
  const broadcast = (session: DebateSession) => {
    for (const listener of listeners.get(session.id) ?? []) listener(session);
  };
  const publish = async (session: DebateSession) => { await store.save(session); broadcast(session); };
  app.addHook('onClose', async () => { for (const controller of controllers.values()) controller.abort(); });

  app.get('/api/health', async () => ({ status: 'ok', version: '0.3.0', milestone: 'M3' }));
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
    if (busy) return reply.code(409).send({ error: 'Another session is running.' });
    busy = true;
    try { return await brainstorm(input, adapters); }
    finally { busy = false; }
  });

  app.post('/api/debates', async (request, reply) => {
    let input;
    try { input = validateDebateRequest(request.body); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid request.' }); }
    if (busy) return reply.code(409).send({ error: 'Another session is running.' });
    const session = createDebateSession(input);
    busy = true;
    store.activate(session.id);
    try { await store.save(session); }
    catch {
      store.deactivate(session.id);
      busy = false;
      return reply.code(500).send({ error: 'Could not persist debate session.' });
    }
    const controller = new AbortController();
    controllers.set(session.id, controller);
    // Work starts after durable creation. Clients subscribe over SSE or poll for updates.
    void executeDebate(session, adapters, publish, controller.signal).catch(async (error: unknown) => {
      app.log.error({ err: error }, 'Debate crashed');
      session.status = 'failed';
      session.phase = null;
      session.finishedAt = new Date().toISOString();
      session.error = 'Debate failed unexpectedly. Completed records remain available.';
      try { await publish(session); }
      catch (writeError) { app.log.error({ err: writeError }, 'Unable to persist failed debate'); }
    }).finally(() => {
      controllers.delete(session.id);
      store.deactivate(session.id);
      busy = false;
    });
    return reply.code(202).send({ id: session.id, status: 'queued' });
  });

  app.post<{ Params: { id: string } }>('/api/debates/:id/cancel', async (request, reply) => {
    const controller = controllers.get(request.params.id);
    if (controller) {
      controller.abort();
      return reply.code(202).send({ status: 'cancelling', id: request.params.id });
    }
    if (!await store.get(request.params.id)) return reply.code(404).send({ error: 'Session not found.' });
    return reply.code(409).send({ error: 'Session is not currently running.' });
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
