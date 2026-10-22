import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../apps/api/src/app.ts';
import { DebateStore } from '../apps/api/src/debate-store.ts';
import { createAdapters } from '../apps/api/src/providers.ts';
import type { DebateSession } from '../packages/core/src/debate.ts';

test('runs all three real spawn adapters end-to-end using protocol-accurate mock CLIs', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ace-cli-e2e-'));
  const bin = join(root, 'bin');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(bin);
  const script = `#!/usr/bin/env node
const { basename } = require('node:path');
const command = basename(process.argv[1]);
if (process.argv.includes('--version')) { console.log('mock 1.0'); process.exit(0); }
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', part => input += part);
process.stdin.on('end', () => {
  if (command === 'agy') {
    input = JSON.parse(input.trim()).message.content;
  }
  if (input.includes('Stage: CRITIQUE') && input.includes('Round 1 of an independent multi-AI')) {
    process.stderr.write('Contradictory stage-specific prompt'); process.exit(2);
  }
  const output = input.includes('Stage: CRITIQUE')
    ? JSON.stringify({ objections: [{ claim: 'Risk assumed away', criticism: 'Evidence is missing', severity: 'medium', evidence: [] }] })
    : input.includes('Stage: REBUTTAL')
    ? JSON.stringify({ responses: [...input.matchAll(/"id":"([0-9a-f-]{36})"/g)].map(m => ({ objectionId: m[1], resolution: 'accepted', reason: 'Will validate' })) })
    : 'A specific, useful simulated response from ' + command;
  if (command === 'claude') console.log(JSON.stringify({ result: output, is_error: false }));
  else if (command === 'agy') console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: output } }));
  else console.log(output);
});`;
  const originalPath = process.env.PATH;
  let app: ReturnType<typeof makeApp> | undefined;
  try {
    for (const name of ['codex', 'claude', 'agy']) {
      const path = join(bin, name);
      await writeFile(path, script, 'utf8');
      await chmod(path, 0o755);
    }
    process.env.PATH = bin + ':' + (originalPath ?? '');
    app = makeApp({ adapters: createAdapters(12000), store: new DebateStore(join(root, 'data')) });
    const request = { prompt: 'Analyze a small autonomous startup studio with risks', providers: ['codex', 'claude', 'gemini'], maxRounds: 1 };
    const m1 = await app.inject({ method: 'POST', url: '/api/brainstorms', payload: request });
    assert.equal(m1.statusCode, 200);
    assert.equal((m1.json() as { status: string }).status, 'completed');
    const started = await app.inject({ method: 'POST', url: '/api/debates', payload: request });
    assert.equal(started.statusCode, 202);
    const id = (started.json() as { id: string }).id;
    let debate: DebateSession | null = null;
    for (let i = 0; i < 450; i++) {
      const response = await app.inject({ method: 'GET', url: '/api/debates/' + id });
      debate = response.json() as DebateSession;
      if (!['queued', 'running'].includes(debate.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(debate?.status, 'completed');
    assert.equal(debate?.calls, 15);
    assert.equal(debate?.entries.length, 15);
    assert.equal(debate?.objections.length, 6);
    assert.ok(debate?.objections.every((objection) => objection.resolution === 'accepted'));
  } finally {
    process.env.PATH = originalPath;
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
