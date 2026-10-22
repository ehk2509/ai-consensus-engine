import { randomUUID } from 'node:crypto';
import type { AgentAdapter, BrainstormResult, BrainstormRequest, ProposalResult } from './types.ts';
import { PROVIDER_IDS } from './types.ts';

export function validateRequest(input: unknown): BrainstormRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A JSON object is required.');
  const value = input as Record<string, unknown>;
  if (typeof value.prompt !== 'string' || value.prompt.trim().length < 10 || value.prompt.length > 12000) {
    throw new Error('Prompt must contain 10–12,000 characters.');
  }
  if (!Array.isArray(value.providers) || value.providers.length === 0 || value.providers.length > PROVIDER_IDS.length ||
      !value.providers.every((id: unknown) => PROVIDER_IDS.includes(id as typeof PROVIDER_IDS[number])) ||
      new Set(value.providers).size !== value.providers.length) {
    throw new Error('Select one or more unique supported providers.');
  }
  return { prompt: value.prompt.trim(), providers: value.providers as BrainstormRequest['providers'] };
}

function safeError(error: unknown): string {
  return error instanceof Error && error.name === 'AgentExecutionError' ? error.message : 'Provider failed unexpectedly.';
}

const INDEPENDENT_INSTRUCTIONS = 'You are independently brainstorming an idea. Present your own concrete solution, assumptions, tradeoffs, alternatives and validation tests. Do not invent other agents\' views, access tools, or modify files.\n\nUSER IDEA:\n';

export async function brainstorm(
  request: BrainstormRequest,
  adapters: ReadonlyMap<string, AgentAdapter>,
): Promise<BrainstormResult> {
  const startedAt = new Date().toISOString();
  const proposals: ProposalResult[] = await Promise.all(request.providers.map(async (provider) => {
    const start = performance.now();
    try {
      const adapter = adapters.get(provider);
      if (!adapter) throw new Error('Unavailable adapter');
      const content = (await adapter.propose(INDEPENDENT_INSTRUCTIONS + request.prompt)).trim();
      if (!content) throw new Error('Empty proposal');
      return { provider, status: 'fulfilled' as const, content, durationMs: Math.round(performance.now() - start) };
    } catch (error) {
      return { provider, status: 'rejected' as const, error: safeError(error), durationMs: Math.round(performance.now() - start) };
    }
  }));
  const successes = proposals.filter((p) => p.status === 'fulfilled').length;
  return {
    runId: randomUUID(), prompt: request.prompt, startedAt,
    finishedAt: new Date().toISOString(), proposals,
    status: successes === 0 ? 'failed' : successes === proposals.length ? 'completed' : 'partial',
  };
}
