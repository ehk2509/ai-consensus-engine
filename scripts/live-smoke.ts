import { makeApp } from '../apps/api/src/app.ts';
import { probeInstalledClis } from '../apps/api/src/providers.ts';
import type { DebateSession } from '../packages/core/src/debate.ts';

if (process.env.ACE_LIVE_SMOKE !== 'I_ACCEPT_MODEL_USAGE') {
  console.error('To intentionally run 15 real AI calls, set ACE_LIVE_SMOKE=I_ACCEPT_MODEL_USAGE.');
  process.exit(2);
}
const installed = await probeInstalledClis();
if (installed.some((x) => !x.installed)) {
  console.error('All three authenticated CLIs (codex, claude, agy) must be on PATH:', installed);
  process.exit(2);
}
const app = makeApp();
try {
  const launched = await app.inject({ method: 'POST', url: '/api/debates', payload: {
    prompt: 'Evaluate the viability, security and economics of a micro-SaaS AI startup studio. Highlight risky assumptions and suggested experiments.',
    providers: ['codex', 'claude', 'gemini'], maxRounds: 1, maxCalls: 15, maxDurationMs: 1800000,
  } });
  if (launched.statusCode !== 202) throw new Error('Failed to start debate: ' + launched.body);
  const id = (launched.json() as { id: string }).id;
  console.log('Running live authenticated three-model smoke. Session:', id);
  let session: DebateSession;
  do {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const response = await app.inject({ method: 'GET', url: '/api/debates/' + id });
    session = response.json() as DebateSession;
    console.log('Stage:', session.phase, 'Round:', session.round, 'Calls:', session.calls, 'Status:', session.status);
  } while (session.status === 'queued' || session.status === 'running');
  const failures = session.entries.filter((e) => e.status !== 'fulfilled');
  console.log('Final:', session.status, 'Entries:', session.entries.length, 'Objections:', session.objections.length, 'Failures:', failures.length);
  if (session.status !== 'completed' || session.calls !== 15 || failures.length !== 0) process.exitCode = 1;
} finally {
  await app.close();
}
