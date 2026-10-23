import { DebateStore } from '../../apps/api/src/debate-store.ts';
const directory = process.env.ACE_LOCK_TEST_DIR;
if (!directory) throw new Error('Missing lock test directory');
const release = await new DebateStore(directory).acquireWorkerLease();
process.stdout.write('LOCK_HELD\n');
process.stdin.resume();
process.stdin.once('end', async () => { await release(); process.exit(0); });
