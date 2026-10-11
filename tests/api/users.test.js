import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startInfra, makeApp, seedUser, uuid } from './harness.js';
import { servicePool, mkProduct } from '../db/helpers.js';

let infra, a, svc, owner, cashier;
before(async () => {
  infra = await startInfra(); a = makeApp(infra); svc = servicePool();
  owner = await seedUser(infra.sup, 'owner');
  cashier = await seedUser(infra.sup, 'cashier');
});
after(async () => { await svc.end(); await infra.stop(); });

const create = (body, app = a, who = owner) => app.as(who).post('/api/users').send({
  email: `c${uuid().slice(0, 8)}@store.test`, password: 'a-long-enough-password', full_name: 'New Cashier', ...body });

describe('cashier account management (owner only)', () => {
  it('creates a cashier who can sell but cannot use owner features', async () => {
    const r = await create({ full_name: 'Juan Dela Cruz' });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.role, 'cashier');
    const id = r.body.data.id;
    assert.equal((await a.as(id).get('/api/me')).body.data.role, 'cashier');
    const p = await mkProduct(svc, owner, { price: 100 });
    assert.equal((await a.as(id).post('/api/checkout').send({ idempotency_key: uuid(), items: [{ product_id: p, qty: 1 }], cash_received_centavos: 100 })).status, 201);
    assert.equal((await a.as(id).get('/api/users')).status, 403);
    assert.equal((await a.as(id).get('/api/dashboard')).status, 403);
  });

  it('cannot be used to create owners or set arbitrary fields (strict body)', async () => {
    for (const extra of [{ role: 'owner' }, { is_active: false }, { id: uuid() }]) {
      assert.equal((await create(extra)).status, 400, JSON.stringify(extra));
    }
  });

  it('validates email and password strength', async () => {
    assert.equal((await create({ email: 'not-an-email' })).status, 400);
    assert.equal((await create({ password: 'short' })).status, 400);
    assert.equal((await create({ password: 'x'.repeat(73) })).status, 400);
    assert.equal((await create({ full_name: '   ' })).status, 400);
  });

  it('duplicate email is 409', async () => {
    const email = `dup${uuid().slice(0, 6)}@store.test`;
    assert.equal((await create({ email })).status, 201);
    const r = await create({ email });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'EMAIL_TAKEN');
  });

  it('if the profile cannot be saved, the just-created login is removed (no orphan account)', async () => {
    const t = makeApp(infra, { authOverrides: { createUser: async () => cashier } });   // id already has a profile
    const r = await create({}, t);
    assert.equal(r.status, 500);
    assert.equal(r.body.error.code, 'INTERNAL_ERROR');
    assert.deepEqual(t.calls.deleteUser, [cashier]);
  });

  it('lists accounts with emails', async () => {
    const r = await a.as(owner).get('/api/users');
    assert.equal(r.status, 200);
    const me = r.body.data.find((u) => u.id === owner);
    assert.equal(me.role, 'owner');
    assert.ok(me.email.endsWith('@test.local'));
  });

  it('deactivating a cashier locks them out immediately; reactivating restores access', async () => {
    const id = (await create({})).body.data.id;
    assert.equal((await a.as(id).get('/api/me')).status, 200);
    const off = await a.as(owner).patch(`/api/users/${id}`).send({ is_active: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.data.is_active, false);
    assert.deepEqual(a.calls.setBanned.at(-1), [id, true]);
    const blocked = await a.as(id).get('/api/me');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'ACCOUNT_DISABLED');
    await a.as(owner).patch(`/api/users/${id}`).send({ is_active: true });
    assert.equal((await a.as(id).get('/api/me')).status, 200);
  });

  it('the owner cannot disable their own account; bad updates are rejected', async () => {
    const r = await a.as(owner).patch(`/api/users/${owner}`).send({ is_active: false });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'CANNOT_DISABLE_SELF');
    assert.equal((await a.as(owner).get('/api/me')).status, 200);
    assert.equal((await a.as(owner).patch(`/api/users/${cashier}`).send({})).status, 400);
    assert.equal((await a.as(owner).patch(`/api/users/${cashier}`).send({ role: 'owner' })).status, 400);
    assert.equal((await a.as(owner).patch(`/api/users/${uuid()}`).send({ is_active: false })).status, 404);
    assert.equal((await infra.sup.query('select role from public.profiles where id=$1', [cashier])).rows[0].role, 'cashier');
  });

  it('account creation is rate limited per owner', async () => {
    const t = makeApp(infra, { rateLimits: { admin: { windowMs: 60_000, limit: 2 } } });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await create({}, t)).status);
    assert.deepEqual(codes, [201, 201, 429, 429]);
  });
});
