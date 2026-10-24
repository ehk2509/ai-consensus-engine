import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stream-json CLIs include non-final events; keep an explicit hard cap on buffered stdout.
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
// stderr is drained and discarded: CLI progress logging must not terminate a valid response.

export class AgentExecutionError extends Error {
  constructor(message: string) { super(message); this.name = 'AgentExecutionError'; }
}
export interface ProcessSpec {
  executable: string;
  args: string[];
  stdin: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Prevent handing the council's own API credential to external provider CLIs and hooks. */
function providerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: 'true', NO_COLOR: '1' };
  delete env.ACE_API_TOKEN;
  delete env.ACE_TOKEN_FILE;
  delete env.ACE_DATA_DIR;
  return env;
}
function terminateTree(pid: number | undefined, fallback: () => void): void {
  if (!pid) { fallback(); return; }
  if (process.platform === 'win32') {
    // Windows process tree termination; do not invoke a shell.
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.on('error', fallback);
    return;
  }
  try {
    // With detached=true below, the child is the process-group leader.
    // Terminate children, grandchildren and the leader together.
    process.kill(-pid, 'SIGKILL');
  } catch {
    fallback();
  }
}

/** Parent-death watchdog: its FD 3 is a pipe held ONLY by the server.
 * When the server is SIGKILLed, EOF triggers killing the CLI process group.
 * The watcher itself is outside the CLI process group. This is POSIX best-effort
 * containment, not a hardened sandbox; use a cgroup/job object for stronger isolation.
 */
const GUARDIAN_SCRIPT = String.raw`
const fs = require('node:fs');
const cp = require('node:child_process');
const pid = Number(process.argv[1]);
const stop = () => {
  if (process.platform === 'win32') {
    const killer = cp.spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    killer.once('close', () => process.exit(0));
    killer.once('error', () => process.exit(0));
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
    process.exit(0);
  }
};
const channel = fs.createReadStream('', { fd: 3, autoClose: false });
channel.once('end', stop);
channel.once('error', stop);
channel.resume();
`;

/** Shell-free, bounded and best-effort process-tree-isolated CLI invocation. */
export async function runAgentProcess(spec: ProcessSpec): Promise<string> {
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) {
    throw new AgentExecutionError('Invalid provider timeout.');
  }
  const cwd = await mkdtemp(join(tmpdir(), 'ace-agent-'));
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(spec.executable, spec.args, {
        cwd, shell: false, detached: process.platform !== 'win32',
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: providerEnvironment(),
      });
      // A separate process notices parent death even if JS cleanup cannot run.
      // The guardian never inherits the API access token or model prompt.
      const guardian = child.pid ? spawn(process.execPath, ['-e', GUARDIAN_SCRIPT, String(child.pid)], {
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'], windowsHide: true,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      }) : null;
      if (guardian) {
        guardian.once('error', () => terminateTree(child.pid, () => child.kill('SIGKILL')));
        guardian.once('exit', () => {
          if (!child.killed && child.exitCode === null) terminateTree(child.pid, () => child.kill('SIGKILL'));
        });
      }
      const stdout: Buffer[] = [];
      let size = 0;
      let timedOut = false;
      let aborted = false;
      let exceeded = false;
      let spawnError: NodeJS.ErrnoException | undefined;
      let terminated = false;
      const terminate = () => {
        if (terminated) return;
        terminated = true;
        terminateTree(child.pid, () => { try { child.kill('SIGKILL'); } catch { /* already exited */ } });
      };
      const onAbort = () => { aborted = true; terminate(); };
      spec.signal?.addEventListener('abort', onAbort, { once: true });
      if (spec.signal?.aborted) onAbort();
      const timer = setTimeout(() => { timedOut = true; terminate(); }, spec.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_OUTPUT_BYTES) { exceeded = true; terminate(); }
        else stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        void chunk; // Drain stderr without buffering or leaking auth-sensitive diagnostics.
      });
      child.on('error', (error: NodeJS.ErrnoException) => { spawnError = error; });
      child.on('close', (code) => {
        const pipe = guardian?.stdio[3];
        if (pipe && 'end' in pipe) (pipe as import('node:stream').Writable).end();
        clearTimeout(timer);
        spec.signal?.removeEventListener('abort', onAbort);
        if (aborted) return reject(new AgentExecutionError('Provider cancelled.'));
        if (spawnError?.code === 'ENOENT') return reject(new AgentExecutionError(`${spec.executable} CLI is not installed or not on PATH.`));
        if (spawnError) return reject(new AgentExecutionError('Unable to launch provider CLI.'));
        if (timedOut) return reject(new AgentExecutionError('Provider timed out.'));
        if (exceeded) return reject(new AgentExecutionError('Provider output exceeded safety limit.'));
        if (code !== 0) return reject(new AgentExecutionError('Provider exited unsuccessfully. Check CLI login and configuration.'));
        const result = Buffer.concat(stdout).toString('utf8');
        if (!result.trim()) return reject(new AgentExecutionError('Provider returned an empty result.'));
        resolve(result);
      });
      child.stdin.on('error', () => { /* Child may exit before stdin finishes. */ });
      child.stdin.end(spec.stdin);
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
