import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Atomic replacement plus explicit syncs: acknowledgement follows the file and
 * parent directory metadata reaching the OS filesystem. This is not a guarantee
 * against device firmware faults or network filesystems with weaker semantics.
 */
export async function durableReplace(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(content, { encoding: 'utf8' });
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
    try {
      const directory = await open(dir, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      // Windows does not allow opening some directory handles through Node.
      // POSIX filesystems must not silently skip the metadata sync.
      if (process.platform !== 'win32') throw error;
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
