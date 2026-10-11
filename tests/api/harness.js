// Test infrastructure for the API: real PostgREST in front of the real test database, the real supabase-js
// client and the real Express app. Only token verification and Auth-admin calls are faked, because they
// need a hosted Supabase Auth server.
import { spawn } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import supertest from 'supertest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { AppError } from '../../src/errors.js';
import { superPool, seedUser, uuid } from '../db/helpers.js';

export { uuid, seedUser };

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function signJwt(payload, secret) {
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
  return `${data}.${crypto.createHmac('sha256', secret).update(data).digest('base64url')}`;
}
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

export async function startInfra() {
  const bin = process.env.POSTGREST_BIN ?? '/tmp/pgrst/postgrest';
  const port = await freePort();
  const secret = crypto.randomBytes(32).toString('hex');
  const serviceKey = signJwt({ role: 'service_role', exp: Math.floor(Date.now() / 1000) + 3600 }, secret);
  const proc = spawn(bin, [], { stdio: ['ignore', 'ignore', 'pipe'], env: {
    PGRST_DB_URI: 'postgres://authenticator:authpw@127.0.0.1:5432/tindahan_test',
    PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: secret,
    PGRST_SERVER_HOST: '127.0.0.1', PGRST_SERVER_PORT: String(port),
    PGRST_DB_MAX_ROWS: '1000',                       // same default cap as hosted Supabase
  } });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/', { headers: { Authorization: `Bearer ${serviceKey}` } }); if (r.ok) break; } catch { /* not up yet */ }
    if (proc.exitCode !== null) throw new Error('PostgREST exited: ' + stderr);
    await new Promise((r) => setTimeout(r, 100));
    if (i === 99) throw new Error('PostgREST did not start: ' + stderr);
  }
  // supabase-js talks to <url>/rest/v1; PostgREST serves at the root, so strip the prefix.
  const db = createClient(base, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, init) => fetch(String(url).replace('/rest/v1', ''), init) },
  });
  const sup = superPool();
  return { db, sup, async stop() { proc.kill(); await sup.end(); } };
}

export function makeApp(infra, { rateLimits, wrapDb, authOverrides, env = {} } = {}) {
  const config = loadConfig({
    NODE_ENV: 'test', SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(40),
    CORS_ORIGINS: 'https://store.example', STORE_NAME: 'Test Tindahan', ...env,
  });
  const huge = { windowMs: 60_000, limit: 1_000_000 };
  config.rateLimits = { general: huge, failedAuth: huge, checkout: huge, admin: huge, ...rateLimits };

  const calls = { deleteUser: [], setBanned: [] };
  const auth = {
    verifyToken: async (t) => (t.startsWith('test-') ? { id: t.slice(5) } : null),
    async createUser({ email }) {
      const dup = await infra.sup.query('select 1 from auth.users where email = $1', [email]);
      if (dup.rowCount) throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists.');
      const id = uuid();
      await infra.sup.query('insert into auth.users (id, email) values ($1,$2)', [id, email]);
      return id;
    },
    async deleteUser(id) { calls.deleteUser.push(id); },
    async setBanned(id, banned) { calls.setBanned.push([id, banned]); },
    async getEmail(id) { return (await infra.sup.query('select email from auth.users where id = $1', [id])).rows[0]?.email ?? null; },
    ...authOverrides,
  };
  const logs = [];
  const logger = { error: (...a) => logs.push(a.map(String).join(' ')) };
  const db = wrapDb ? wrapDb(infra.db) : infra.db;
  const app = createApp({ config, db, auth, logger });
  const request = supertest(app);
  /** A caller logged in as the given user id (the fake verifier accepts "test-<id>"). */
  const as = (userId) => {
    const h = (r) => r.set('Authorization', `Bearer test-${userId}`);
    return { get: (p) => h(request.get(p)), post: (p) => h(request.post(p)), put: (p) => h(request.put(p)),
      patch: (p) => h(request.patch(p)) };
  };
  return { app, request, as, calls, logs, config };
}

export const noToken = (request) => request;
