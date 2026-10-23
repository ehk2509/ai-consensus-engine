import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeApp } from '../apps/api/src/app.ts';
import { DebateStore } from '../apps/api/src/debate-store.ts';
import type { AgentAdapter } from '../packages/core/src/types.ts';
import type { DebateSession } from '../packages/core/src/debate.ts';

test('actual SIGKILL during in-flight provider calls leaves durable uncertain intents; restart refuses replay', {
  skip: process.platform === 'win32',
  timeout: 25000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ace-m4-crash-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/m4-crash-child.ts'], {
    cwd: process.cwd(), env: { ...process.env, ACE_CRASH_TEST_DIRECTORY: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', address = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; const hit = /ACE_CRASH_READY=(http:\/\/[^\s]+)/.exec(output); if (hit) address = hit[1]!; });
  let errors = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { errors += chunk; });
  let restarted: ReturnType<typeof makeApp> | undefined;
  try {
    for (let i = 0; i < 200 && !address && child.exitCode === null; i++)
      await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(address, 'Child did not start: ' + errors.slice(0, 1000));
    const resp = await fetch(address + '/api/debates', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Review a controlled software startup experiment', providers: ['codex', 'claude'], maxRounds: 1 }),
    });
    assert.equal(resp.status, 202);
    const id = (await resp.json() as { id: string }).id;
    const store = new DebateStore(directory);
    let snapshot: DebateSession | null = null;
    for (let i = 0; i < 250; i++) {
      snapshot = await store.getPersisted(id);
      if (snapshot && snapshot.entries.filter(e => e.status === 'issued').length === 2) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(snapshot);
    assert.equal(snapshot.entries.filter(e => e.status === 'issued').length, 2);
    assert.equal(snapshot.calls, 2);
    child.kill('SIGKILL');
    await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()); });
    const observedCalls: string[] = [];
    const adapters = new Map<string, AgentAdapter>([
      ['codex', { id: 'codex', propose: async () => { observedCalls.push('codex'); return 'response'; } }],
      ['claude', { id: 'claude', propose: async () => { observedCalls.push('claude'); return 'response'; } }],
    ]);
    restarted = makeApp({ adapters, store: new DebateStore(directory) });
    const interrupted = await restarted.inject({ method: 'GET', url: '/api/debates/' + id });
    assert.equal((interrupted.json() as DebateSession).status, 'interrupted');
    const attempt = await restarted.inject({ method: 'POST', url: '/api/debates/' + id + '/resume', payload: {} });
    assert.equal(attempt.statusCode, 409);
    const uncertain = (attempt.json() as { uncertainCallIds: string[] }).uncertainCallIds;
    assert.equal(uncertain.length, 2);
    assert.deepEqual(observedCalls, []);
    const persisted = await new DebateStore(directory).getPersisted(id);
    assert.equal(persisted?.calls, 2);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    if (restarted) await restarted.close();
    await rm(directory, { recursive: true, force: true });
  }
});
