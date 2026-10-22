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
  let busy = false;

  const broadcast = (session: DebateSession) => {
    for (const listener of listeners.get(session.id) ?? []) listener(session);
  };
  const publish = async (session: DebateSession) => { await store.save(session); broadcast(session); };

  app.get('/api/health', async () => ({ status: 'ok', version: '0.2.0', milestone: 'M2' }));
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
    // Work starts after the session has been durably created; clients subscribe using EventSource.
    void executeDebate(session, adapters, publish).catch(async () => {
      session.status = 'failed';
      session.phase = null;
      session.finishedAt = new Date().toISOString();
      session.error = 'Debate failed unexpectedly.';
      try { await publish(session); }
      catch { app.log.error('Unable to persist failed debate'); }
    }).finally(() => { busy = false; store.deactivate(session.id); });
    return reply.code(202).send({ id: session.id, status: 'queued' });
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
    const session = await store.get(request.params.id);
    if (!session) return reply.code(404).send({ error: 'Session not found.' });
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    let closed = false;
    const signal = (value: DebateSession) => {
      if (closed) return;
      reply.raw.write('event: update\ndata: ' + JSON.stringify({
        id: value.id, status: value.status, phase: value.phase, round: value.round, updatedAt: value.updatedAt,
      }) + '\n\n');
      if (!['queued', 'running'].includes(value.status)) cleanup(true);
    };
    const listenerSet = listeners.get(session.id) ?? new Set<(value: DebateSession) => void>();
    listeners.set(session.id, listenerSet);
    listenerSet.add(signal);
    const heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(': keepalive\n\n');
    }, 20000);
    const cleanup = (finish = false) => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      listenerSet.delete(signal);
      if (listenerSet.size === 0) listeners.delete(session.id);
      if (finish && !reply.raw.destroyed) reply.raw.end();
    };
    request.raw.on('close', () => cleanup());
    signal(session);
  });

  return app;
}
