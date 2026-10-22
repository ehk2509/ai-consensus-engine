import Fastify from 'fastify';
import { brainstorm, validateRequest } from '../../../packages/core/src/brainstorm.ts';
import { PROVIDER_IDS } from '../../../packages/core/src/types.ts';
import type { AgentAdapter } from '../../../packages/core/src/types.ts';
import { createAdapters, probeInstalledClis } from './providers.ts';
export interface AppOptions { adapters?: Map<string, AgentAdapter>; }
export function makeApp(options: AppOptions = {}) {
  const app = Fastify({ logger: true, bodyLimit: 16 * 1024 });
  const adapters = options.adapters ?? createAdapters();
  let running = false;
  app.get('/api/health', async () => ({ status: 'ok', version: '0.1.0', milestone: 'M1' }));
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
    if (running) return reply.code(409).send({ error: 'Another brainstorming session is running. Try again when it finishes.' });
    running = true;
    try { return await brainstorm(input, adapters); }
    finally { running = false; }
  });
  return app;
}
