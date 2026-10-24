import test from 'node:test';
import assert from 'node:assert/strict';
import { brainstorm, validateRequest } from '../packages/core/src/brainstorm.ts';
import type { AgentAdapter } from '../packages/core/src/types.ts';

const adapter = (id: AgentAdapter['id'], propose: AgentAdapter['propose']): AgentAdapter => ({ id, propose });

test('validates prompt and unique known providers', () => {
  assert.deepEqual(validateRequest({ prompt: '  A new product idea  ', providers: ['codex', 'gemini'] }), { prompt: '  A new product idea  ', providers: ['codex', 'gemini'] });
  for (const value of [null, {}, { prompt: 'short', providers: ['codex'] }, { prompt: 'This is a valid idea', providers: [] }, { prompt: 'This is a valid idea', providers: ['codex', 'codex'] }, { prompt: 'This is a valid idea', providers: ['unknown'] }, { prompt: 'X'.repeat(1000001), providers: ['claude'] }]) {
    assert.throws(() => validateRequest(value));
  }
});

test('runs proposals concurrently and preserves selection order', async () => {
  let started = 0;
  let release: (() => void) | undefined;
  const allStarted = new Promise<void>((resolve) => { release = resolve; });
  const makeAdapter = (id: AgentAdapter['id']) => adapter(id, async () => {
    started += 1;
    if (started === 3) release?.();
    await allStarted;
    return `${id}: proposal`;
  });
  const adapters = new Map<string, AgentAdapter>(['codex', 'claude', 'gemini'].map((id) => [id, makeAdapter(id as AgentAdapter['id'])]));
  const result = await brainstorm({ prompt: 'Design a startup platform', providers: ['gemini', 'codex', 'claude'] }, adapters);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.proposals.map((p) => p.provider), ['gemini', 'codex', 'claude']);
  assert.ok(result.proposals.every((p) => p.status === 'fulfilled'));
  assert.match(result.runId, /^[0-9a-f-]{36}$/);
});

test('isolates provider failures without leaking internal errors', async () => {
  const adapters = new Map<string, AgentAdapter>([
    ['codex', adapter('codex', async () => 'A valid proposal')],
    ['claude', adapter('claude', async () => { throw new Error('MY SECRET TOKEN'); })],
  ]);
  const result = await brainstorm({ prompt: 'Design a startup platform', providers: ['codex', 'claude'] }, adapters);
  assert.equal(result.status, 'partial');
  const failure = result.proposals[1];
  assert.equal(failure?.status, 'rejected');
  if (failure?.status === 'rejected') assert.equal(failure.error, 'Provider failed unexpectedly.');
  const failed = await brainstorm({ prompt: 'Design a startup platform', providers: ['claude'] }, adapters);
  assert.equal(failed.status, 'failed');
});
