import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_OUTPUT_BYTES = 768 * 1024;
const MAX_ERROR_BYTES = 32 * 1024;

export class AgentExecutionError extends Error {
  constructor(message: string) { super(message); this.name = 'AgentExecutionError'; }
}
export interface ProcessSpec {
  executable: string;
  args: string[];
  stdin: string;
  timeoutMs: number;
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

/** Shell-free, bounded and best-effort process-tree-isolated CLI invocation. */
export async function runAgentProcess(spec: ProcessSpec): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'ace-agent-'));
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(spec.executable, spec.args, {
        cwd, shell: false, detached: process.platform !== 'win32',
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CI: 'true', NO_COLOR: '1' },
      });
      const stdout: Buffer[] = [];
      let size = 0;
      let errorSize = 0;
      let timedOut = false;
      let exceeded = false;
      let spawnError: NodeJS.ErrnoException | undefined;
      let terminated = false;
      const terminate = () => {
        if (terminated) return;
        terminated = true;
        terminateTree(child.pid, () => { try { child.kill('SIGKILL'); } catch { /* already exited */ } });
      };
      const timer = setTimeout(() => { timedOut = true; terminate(); }, spec.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_OUTPUT_BYTES) { exceeded = true; terminate(); }
        else stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errorSize += chunk.length;
        if (errorSize > MAX_ERROR_BYTES) { exceeded = true; terminate(); }
      });
      child.on('error', (error: NodeJS.ErrnoException) => { spawnError = error; });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (spawnError?.code === 'ENOENT') return reject(new AgentExecutionError(`${spec.executable} CLI is not installed or not on PATH.`));
        if (spawnError) return reject(new AgentExecutionError('Unable to launch provider CLI.'));
        if (timedOut) return reject(new AgentExecutionError('Provider timed out.'));
        if (exceeded) return reject(new AgentExecutionError('Provider output exceeded safety limit.'));
        if (code !== 0) return reject(new AgentExecutionError('Provider exited unsuccessfully. Check CLI login and configuration.'));
        const result = Buffer.concat(stdout).toString('utf8').trim();
        if (!result) return reject(new AgentExecutionError('Provider returned an empty result.'));
        resolve(result);
      });
      child.stdin.on('error', () => { /* Child may exit before stdin finishes. */ });
      child.stdin.end(spec.stdin);
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
