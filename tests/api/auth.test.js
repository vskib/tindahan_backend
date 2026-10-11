import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startInfra, makeApp, seedUser, uuid } from './harness.js';
import { loadConfig } from '../../src/config.js';

let infra, a, owner, cashier;
before(async () => {
  infra = await startInfra(); a = makeApp(infra);
  owner = await seedUser(infra.sup, 'owner', { name: 'Aling Nena' });
  cashier = await seedUser(infra.sup, 'cashier');
});
after(async () => { await infra.stop(); });

describe('authentication boundary (token verification)', () => {
  it('health check is public', async () => {
    const r = await a.request.get('/api/health');
    assert.equal(r.status, 200);
  });

  it('rejects missing, malformed, wrong-scheme and invalid tokens with 401', async () => {
    for (const h of [undefined, '', 'Bearer', 'Bearer ', 'Basic dXNlcjpwYXNz', 'Bearer not-a-valid-token', 'Bearer a b']) {
      const req = a.request.get('/api/me');
      if (h !== undefined) req.set('Authorization', h);
      const r = await req;
      assert.equal(r.status, 401, `header ${JSON.stringify(h)}`);
      assert.ok(['UNAUTHENTICATED', 'SESSION_EXPIRED'].includes(r.body.error.code));
    }
    assert.equal((await a.request.get('/api/me').set('Authorization', 'Bearer ' + 'a'.repeat(5000))).status, 401);
  });

  it('a valid session returns the profile; role comes from the database', async () => {
    const r = await a.as(owner).get('/api/me');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data, { id: owner, full_name: 'Aling Nena', role: 'owner', store_name: 'Test Tindahan' });
    assert.equal((await a.as(cashier).get('/api/me')).body.data.role, 'cashier');
  });

  it('a verified user with no profile is refused (403)', async () => {
    const r = await a.as(uuid()).get('/api/me');
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'NO_PROFILE');
  });

  it('a deactivated account loses access immediately, even with a still-valid token', async () => {
    const u = await seedUser(infra.sup, 'cashier');
    assert.equal((await a.as(u).get('/api/me')).status, 200);
    await infra.sup.query('update public.profiles set is_active = false where id = $1', [u]);
    const r = await a.as(u).get('/api/me');
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'ACCOUNT_DISABLED');
  });

  it('503 (not a crash or a false login) when the auth service is down', async () => {
    const down = makeApp(infra, { authOverrides: { verifyToken: async () => { throw new Error('network'); } } });
    const r = await down.as(owner).get('/api/me');
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'AUTH_UNAVAILABLE');
  });
});

// NOTE: logging in and out are performed by Supabase Auth directly from the browser; the Express API has
// no login/logout endpoints. They cannot be exercised without a hosted Supabase project and are covered by
// the manual verification checklist (Phase 6), not by these automated tests.

describe('safe error handling and HTTP hardening', () => {
  it('unknown routes and bad JSON return clean JSON errors', async () => {
    const r1 = await a.as(owner).get('/api/nope');
    assert.equal(r1.status, 404);
    assert.deepEqual(Object.keys(r1.body.error).sort(), ['code', 'message']);
    const r2 = await a.as(owner).post('/api/checkout').set('Content-Type', 'application/json').send('{"bad json');
    assert.equal(r2.status, 400);
    assert.equal(r2.body.error.code, 'BAD_JSON');
    const r3 = await a.as(owner).post('/api/checkout').send({ x: 'y'.repeat(200_000) });
    assert.equal(r3.status, 413);
  });

  it('internal failures return a generic 500; secrets, stack traces and file paths stay in the server log', async () => {
    const boom = makeApp(infra, { wrapDb: (db) => ({
      from: (t) => { if (t === 'products') throw new Error('SECRET postgres://user:hunter2@host/db'); return db.from(t); },
      rpc: (...x) => db.rpc(...x),
    }) });
    const r = await boom.as(owner).get('/api/products');
    assert.equal(r.status, 500);
    assert.equal(r.body.error.code, 'INTERNAL_ERROR');
    const text = JSON.stringify(r.body);
    for (const leak of ['SECRET', 'hunter2', 'postgres://', 'node_modules', ' at ', '.js']) assert.ok(!text.includes(leak), leak);
    assert.ok(boom.logs.some((l) => l.includes('SECRET')), 'details are logged server-side');
  });

  it('sets security headers and does not advertise Express', async () => {
    const r = await a.request.get('/api/health');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['x-powered-by'], undefined);
    assert.ok(r.headers['strict-transport-security']);
  });

  it('CORS: only the configured origin is allowed', async () => {
    const ok = await a.request.get('/api/health').set('Origin', 'https://store.example');
    assert.equal(ok.headers['access-control-allow-origin'], 'https://store.example');
    const bad = await a.request.get('/api/health').set('Origin', 'https://evil.example');
    assert.equal(bad.headers['access-control-allow-origin'], undefined);
    const pre = await a.request.options('/api/checkout').set('Origin', 'https://store.example')
      .set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'authorization,content-type');
    assert.equal(pre.headers['access-control-allow-origin'], 'https://store.example');
    const preBad = await a.request.options('/api/checkout').set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    assert.equal(preBad.headers['access-control-allow-origin'], undefined);
  });
});

describe('rate limiting', () => {
  it('repeated failed authentication from one IP is throttled (429)', async () => {
    const t = makeApp(infra, { rateLimits: { failedAuth: { windowMs: 60_000, limit: 5 } } });
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push((await t.request.get('/api/me').set('Authorization', 'Bearer bad-token')).status);
    assert.deepEqual(codes, [401, 401, 401, 401, 401, 429, 429, 429]);
    assert.equal((await t.request.get('/api/health')).status, 429);      // the offending IP stays throttled for the window
  });

  it('successful requests do not trip the failed-auth limiter', async () => {
    const t = makeApp(infra, { rateLimits: { failedAuth: { windowMs: 60_000, limit: 3 } } });
    for (let i = 0; i < 10; i++) assert.equal((await t.as(owner).get('/api/me')).status, 200);
  });

  it('general limiter caps request volume', async () => {
    const t = makeApp(infra, { rateLimits: { general: { windowMs: 60_000, limit: 4 } } });
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await t.request.get('/api/health')).status);
    assert.deepEqual(codes, [200, 200, 200, 200, 429, 429]);
  });
});

describe('configuration safety', () => {
  const good = { SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k'.repeat(40) };
  it('accepts a valid production config', () => {
    const c = loadConfig({ ...good, NODE_ENV: 'production', CORS_ORIGINS: 'https://shop.example' });
    assert.deepEqual(c.corsOrigins, ['https://shop.example']);
  });
  it('fails fast on missing or unsafe settings', () => {
    assert.throws(() => loadConfig({}), /SUPABASE_URL/);
    assert.throws(() => loadConfig({ ...good, SUPABASE_SERVICE_ROLE_KEY: 'short' }), /SERVICE_ROLE_KEY/);
    assert.throws(() => loadConfig({ ...good, NODE_ENV: 'production' }), /CORS_ORIGINS is required/);
    assert.throws(() => loadConfig({ ...good, NODE_ENV: 'production', CORS_ORIGINS: 'http://shop.example' }), /https/);
    assert.throws(() => loadConfig({ ...good, CORS_ORIGINS: '*' }), /not allowed/);
  });
});
