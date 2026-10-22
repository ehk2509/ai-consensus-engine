import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../apps/api/src/app.ts';
import { DebateStore } from '../apps/api/src/debate-store.ts';
import { createAdapters } from '../apps/api/src/providers.ts';
import type { DebateSession } from '../packages/core/src/debate.ts';

test('M3 runs 19 real subprocess calls using three mock CLI protocols and persists a unanimous report', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ace-consensus-cli-'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  const fake = `#!/usr/bin/env node
const { basename } = require('node:path');
const provider = basename(process.argv[1]);
if (process.argv.includes('--version')) { console.log('mock 1.0'); process.exit(0); }
let message = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', x => message += x);
process.stdin.on('end', () => {
  if (provider === 'agy') message = JSON.parse(message.trim()).message.content;
  let response = '';
  if (message.includes('Stage: CRITIQUE')) response = JSON.stringify({ objections: [] });
  else if (message.includes('Stage: REBUTTAL')) response = JSON.stringify({ responses: [] });
  else if (message.includes('Stage: CONSENSUS DRAFT')) response = JSON.stringify({
    proposal: 'Perform a controlled customer pilot with well-defined success metrics.',
    assumptions: ['Customers can be recruited'],
    evidence: [{ claim: 'Demand estimate from the founder' }],
  });
  else if (message.includes('Stage: INDEPENDENT CONSENSUS VOTE')) response = JSON.stringify({
    verdict: 'accept', rationale: 'Agreed to run a controlled pilot', concerns: [], resolvedObjectionIds: [],
  });
  else response = 'Detailed initial or revised proposal from ' + provider;
  if (provider === 'claude') console.log(JSON.stringify({ result: response }));
  else if (provider === 'agy') console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response } }));
  else console.log(response);
});`;
  const originalPath = process.env.PATH;
  let app: ReturnType<typeof makeApp> | undefined;
  try {
    for (const cli of ['codex', 'claude', 'agy']) {
      const path = join(bin, cli);
      await writeFile(path, fake, 'utf8');
      await chmod(path, 0o755);
    }
    process.env.PATH = bin + ':' + (originalPath ?? '');
    app = makeApp({ adapters: createAdapters(12000), store: new DebateStore(join(root, 'sessions')) });
    const started = await app.inject({ method: 'POST', url: '/api/debates', payload: {
      prompt: 'Evaluate an AI startup studio and critical business risks',
      providers: ['codex', 'claude', 'gemini'], maxRounds: 1, consensus: true,
      maxCalls: 23, quorum: 'unanimous', blockCritical: true,
    } });
    assert.equal(started.statusCode, 202);
    const id = (started.json() as { id: string }).id;
    let session: DebateSession | null = null;
    for (let i = 0; i < 450; i++) {
      const response = await app.inject({ method: 'GET', url: '/api/debates/' + id });
      session = response.json() as DebateSession;
      if (!['queued', 'running'].includes(session.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(session?.status, 'completed');
    assert.equal(session?.calls, 19);
    assert.equal(session?.consensus?.status, 'unanimous');
    assert.equal(session?.consensus?.votes.length, 3);
    assert.equal(session?.consensus?.draft?.evidence[0]?.verification, 'unverified');
    const report = await app.inject({ method: 'GET', url: '/api/debates/' + id + '/report' });
    assert.equal(report.statusCode, 200);
    assert.match(report.body, /not independently verified/);
  } finally {
    process.env.PATH = originalPath;
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
