import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const COOKIE = 'ace_session';
const LIFETIME_MS = 12 * 60 * 60 * 1000;
const safeEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
export function installLocalAuth(app: FastifyInstance, secret?: string): void {
  if (secret !== undefined && secret.length < 24) {
    throw new Error('ACE_API_TOKEN must have at least 24 characters.');
  }
  function signature(expiry: string): string {
    return createHmac('sha256', secret!).update('ace-v1:' + expiry).digest('hex');
  }
  function authenticated(headers: Record<string, unknown>): boolean {
    if (!secret) return true;
    const authorization = typeof headers.authorization === 'string' ? headers.authorization : '';
    if (authorization.startsWith('Bearer ') && safeEqual(authorization.slice(7), secret)) return true;
    const cookies = typeof headers.cookie === 'string' ? headers.cookie : '';
    const value = cookies.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    if (!value) return false;
    const [expiry, received, extra] = value.split('.');
    if (!expiry || !received || extra || !/^\d{13}$/.test(expiry) || Number(expiry) <= Date.now()) return false;
    return safeEqual(received, signature(expiry));
  }
  app.get('/api/auth/status', async request =>
    ({ required: !!secret, authenticated: authenticated(request.headers) }));
  app.post<{ Body: { token?: string } }>('/api/auth/login', async (request, reply) => {
    if (!secret) return { authenticated: true, required: false };
    const supplied = request.body && typeof request.body.token === 'string' ? request.body.token : '';
    if (!safeEqual(supplied, secret)) return reply.code(401).send({ error: 'Invalid access token.' });
    const expiry = String(Date.now() + LIFETIME_MS);
    const cookie = COOKIE + '=' + expiry + '.' + signature(expiry) +
      '; HttpOnly; SameSite=Strict; Path=/api; Max-Age=43200' +
      ((request.headers['x-forwarded-proto'] === 'https' || request.protocol === 'https') ? '; Secure' : '');
    reply.header('Set-Cookie', cookie);
    reply.header('Cache-Control', 'no-store');
    return { authenticated: true, required: true };
  });
  app.addHook('onRequest', async (request, reply) => {
    if (!secret || !request.url.startsWith('/api/')) return;
    const path = request.url.split('?')[0];
    if (path === '/api/health' || path === '/api/auth/status' || path === '/api/auth/login') return;
    if (!authenticated(request.headers)) {
      reply.header('Cache-Control', 'no-store');
      return reply.code(401).send({ error: 'Local API authentication required.' });
    }
    // SameSite=Strict cookies defend against cross-site requests; bearer credentials are
    // intentionally supported for headless API clients, and never accepted in query params.
  });
}
