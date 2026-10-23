import { makeApp } from '../../apps/api/src/app.ts';
import { DebateStore } from '../../apps/api/src/debate-store.ts';
import type { AgentAdapter } from '../../packages/core/src/types.ts';
const directory = process.env.ACE_CRASH_TEST_DIRECTORY;
if (!directory) throw new Error('Missing crash test directory');
const hanging = (): Promise<string> => new Promise(() => {});
const adapters = new Map<string, AgentAdapter>([
  ['codex', { id: 'codex', propose: hanging }],
  ['claude', { id: 'claude', propose: hanging }],
]);
const app = makeApp({ adapters, store: new DebateStore(directory) });
const address = await app.listen({ host: '127.0.0.1', port: 0 });
process.stdout.write('ACE_CRASH_READY=' + address + '\n');
