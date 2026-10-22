import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DebateStore } from '../apps/api/src/debate-store.ts';
import { createDebateSession } from '../packages/core/src/debate.ts';

test('persists, lists, reloads and identifies interrupted sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ace-store-test-'));
  try {
    const store = new DebateStore(dir);
    const session = createDebateSession({ prompt: 'A debate about AI startup strategy', providers: ['codex', 'claude'], maxRounds: 1 });
    await store.save(session);
    assert.equal((await store.get(session.id))?.status, 'interrupted');
    store.activate(session.id);
    session.status = 'running';
    await store.save(session);
    assert.equal((await store.get(session.id))?.status, 'running');
    session.status = 'completed';
    session.finishedAt = new Date().toISOString();
    await store.save(session);
    store.deactivate(session.id);
    assert.equal((await store.get(session.id))?.status, 'completed');
    assert.equal((await new DebateStore(dir).list()).length, 1);
    assert.equal(await store.get('../../etc/passwd'), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('concurrent writes cannot overwrite the final snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ace-store-order-'));
  try {
    const store = new DebateStore(dir);
    const session = createDebateSession({ prompt: 'A debate about AI startup strategy', providers: ['codex', 'claude'], maxRounds: 1 });
    const saves = [];
    for (let i = 1; i <= 15; i++) {
      session.round = i;
      saves.push(store.save(session));
    }
    await Promise.all(saves);
    assert.equal((await store.get(session.id))?.round, 15);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
