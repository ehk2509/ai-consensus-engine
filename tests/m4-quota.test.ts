import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DailyCallQuota, environmentQuotaLimits, parseQuotaLimit } from '../apps/api/src/quota.ts';
import { DebateStore } from '../apps/api/src/debate-store.ts';
import { makeApp } from '../apps/api/src/app.ts';
import type { AgentAdapter } from '../packages/core/src/types.ts';
import type { DebateSession } from '../packages/core/src/debate.ts';

test('durable daily quota persists across restarts and enforces per-provider and global thresholds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ace-m4-quota-'));
  try {
    const config = { total: 2, providers: { codex: 1 } };
    const ledger = new DailyCallQuota(dir, config);
    await ledger.reserve('codex');
    await assert.rejects(ledger.reserve('codex'), /codex call quota exhausted/);
    await ledger.reserve('claude');
    await assert.rejects(ledger.reserve('gemini'), /total provider-call quota exhausted/);
    const restarted = new DailyCallQuota(dir, config);
    const record = await restarted.snapshot();
    assert.equal(record.total, 2);
    assert.equal(record.providers.codex, 1);
    assert.equal(record.providers.claude, 1);
    const mode = (await stat(join(dir, '.quota-' + record.date + '.json'))).mode & 0o777;
    if (process.platform !== 'win32') assert.equal(mode, 0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('parallel model reservations cannot race past the daily quota', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ace-m4-concurrent-'));
  try {
    const ledger = new DailyCallQuota(dir, { total: 3 });
    const outcomes = await Promise.allSettled(Array.from({ length: 18 }, () => ledger.reserve('claude')));
    assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 3);
    assert.equal((await ledger.snapshot()).total, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('quota environment parser rejects invalid values and accepts explicit zero', () => {
  assert.equal(parseQuotaLimit(undefined), undefined);
  assert.equal(parseQuotaLimit('0'), 0);
  assert.equal(parseQuotaLimit('500'), 500);
  for (const invalid of ['-1', '1.5', 'infinity', 'abc', '99999999']) assert.throws(() => parseQuotaLimit(invalid));
  assert.deepEqual(environmentQuotaLimits({ ACE_DAILY_CALL_LIMIT: '5', ACE_CODEX_DAILY_CALL_LIMIT: '1' }),
    { total: 5, providers: { codex: 1, claude: undefined, gemini: undefined } });
});

test('API metering charges only accepted provider-call reservations even if debate attempts more stages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ace-m4-api-quota-'));
  let actual = 0;
  const adapters = new Map<string, AgentAdapter>([
    ['codex', { id: 'codex', propose: async () => { actual++; return 'A'; } }],
    ['claude', { id: 'claude', propose: async () => { actual++; return 'B'; } }],
  ]);
  const app = makeApp({ adapters, store: new DebateStore(dir), quotaLimits: { total: 2 } });
  try {
    const result = await app.inject({ method: 'POST', url: '/api/debates', payload: {
      prompt: 'Assess accountable startup operations and economic viability',
      providers: ['codex', 'claude'], maxRounds: 1,
    } });
    assert.equal(result.statusCode, 202);
    const id = (result.json() as { id: string }).id;
    let final: DebateSession | undefined;
    for (let i = 0; i < 150; i++) {
      const got = await app.inject({ method: 'GET', url: '/api/debates/' + id });
      const session = got.json() as DebateSession;
      if (!['running', 'queued'].includes(session.status)) { final = session; break; }
      await new Promise(done => setTimeout(done, 15));
    }
    assert.ok(final);
    assert.equal(actual, 2);
    assert.equal(final.status, 'partial');
    const metrics = (await app.inject('/api/metrics')).json() as { dailyQuota: { total: number } };
    assert.equal(metrics.dailyQuota.total, 2);
    assert.equal((await new DailyCallQuota(dir).snapshot()).total, 2);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
