import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { makeApp } from './app.ts';

const port = Number(process.env.ACE_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ACE_PORT must be between 1 and 65535.');
const tokenPath = resolve(process.env.ACE_TOKEN_FILE ?? '.ace-data/api-token');
async function getAccessToken(): Promise<string> {
  if (process.env.ACE_API_TOKEN !== undefined) {
    if (process.env.ACE_API_TOKEN.length < 24) throw new Error('ACE_API_TOKEN must be at least 24 characters.');
    return process.env.ACE_API_TOKEN;
  }
  await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
  try { return (await readFile(tokenPath, 'utf8')).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const generated = randomBytes(32).toString('hex');
  try { await writeFile(tokenPath, generated + '\n', { flag: 'wx', mode: 0o600 }); return generated; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return (await readFile(tokenPath, 'utf8')).trim();
  }
}
const apiToken = await getAccessToken();
if (apiToken.length < 24) throw new Error('Invalid local token file: access token too short.');
const app = makeApp({ apiToken });
const close = async () => { await app.close(); process.exit(0); };
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
await app.listen({ port, host: '127.0.0.1' });
if (!process.env.ACE_API_TOKEN) {
  console.info('M4 local access token is stored with restricted permissions at ' + tokenPath);
}
