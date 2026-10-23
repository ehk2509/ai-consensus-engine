import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Kernel-enforced lock. Ownership belongs to a child whose stdin pipe is held by
 * this server. SIGKILL closes that pipe, releasing the OS lock without stale-PID
 * unlink races. Never delete or rename a live lockfile.
 */
export async function acquireLocalWorkerLease(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockfile = join(directory, '.worker-owner.lock');
  const fd = await open(lockfile, 'a', 0o600);
  await fd.close();
  const ready = 'ACE_LOCK_ACQUIRED';
  let command: string;
  let args: string[];
  if (process.platform === 'win32') {
    const escapedPath = lockfile.replace(/'/g, "''");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$f = [System.IO.File]::Open('" + escapedPath + "', [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)",
      "[Console]::Out.WriteLine('" + ready + "')",
      "[Console]::Out.Flush()",
      "try { [Console]::In.ReadToEnd() | Out-Null } finally { $f.Dispose() }",
    ].join('; ');
    command = 'powershell.exe';
    args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  } else {
    command = 'flock';
    args = ['-n', '--', lockfile, 'sh', '-c', 'printf "' + ready + '\\n"; exec cat >/dev/null'];
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (error) {
    throw new Error('Worker lock helper could not launch: ' + String(error));
  }
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-500); });
  try {
    await new Promise<void>((resolve, reject) => {
      let resolved = false, output = '';
      const rejectOnce = (error: Error) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => rejectOnce(new Error('Timed out acquiring OS worker lock.')), 5000);
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (!resolved && output.includes(ready)) {
          resolved = true;
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('error', (error) => rejectOnce(new Error('Worker lock helper unavailable: ' + error.message)));
      child.once('exit', () => rejectOnce(new Error('Another worker owns this data directory, or OS lock failed. ' + stderr)));
    });
  } catch (error) {
    child.stdin.destroy();
    child.kill();
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { child.kill(); resolve(); }, 2000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  };
}
