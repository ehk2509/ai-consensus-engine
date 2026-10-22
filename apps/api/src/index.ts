import { makeApp } from './app.ts';
const port = Number(process.env.ACE_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ACE_PORT must be between 1 and 65535.');
const app = makeApp();
const close = async () => { await app.close(); process.exit(0); };
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
await app.listen({ port, host: '127.0.0.1' });
