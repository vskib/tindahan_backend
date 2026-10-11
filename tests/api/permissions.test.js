import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startInfra, makeApp, seedUser, uuid } from './harness.js';
import { servicePool, mkProduct } from '../db/helpers.js';

let infra, a, svc, owner, cashier, cashier2, product, archived;
const tag = 'PT' + uuid().slice(0, 6);   // unique per run so a reused database does not collide
before(async () => {
  infra = await startInfra(); a = makeApp(infra); svc = servicePool();
  owner = await seedUser(infra.sup, 'owner');
  cashier = await seedUser(infra.sup, 'cashier');
  cashier2 = await seedUser(infra.sup, 'cashier');
  product = await mkProduct(svc, owner, { name: `${tag} Soap`, price: 1000, cost: 600, stock: 20 });
  archived = await mkProduct(svc, owner, { name: `${tag} Archived`, price: 500, cost: 300, stock: 5 });
  await svc.query('select public.set_product_active($1,$2,false)', [owner, archived]);
});
after(async () => { await svc.end(); await infra.stop(); });

const OWNER_ONLY = () => [
  ['post', '/api/products', { name: 'x', price_centavos: 100, cost_centavos: 50 }],
  ['put', `/api/products/${product}`, { name: 'x', barcode: null, price_centavos: 100, low_stock_threshold: 1 }],
  ['post', `/api/products/${product}/archive`, {}],
  ['post', `/api/products/${product}/restore`, {}],
  ['post', `/api/products/${product}/stock-adjustments`, { delta: 5, reason: 'new_delivery' }],
  ['get', '/api/inventory/movements'],
  ['get', '/api/inventory/low-stock'],
  ['get', '/api/reports/daily-sales?from=2030-01-01&to=2030-01-02'],
  ['get', '/api/dashboard'],
  ['get', '/api/users'],
  ['post', '/api/users', { email: 'a@b.co', password: 'longenoughpass', full_name: 'X' }],
  ['patch', `/api/users/${cashier2}`, { is_active: false }],
];
const send = (req, body) => (body ? req.send(body) : req);

describe('owner-only endpoints', () => {
  it('reject unauthenticated callers with 401', async () => {
    for (const [m, path, body] of OWNER_ONLY()) {
      const r = await send(a.request[m](path), body);
      assert.equal(r.status, 401, `${m} ${path}`);
    }
    for (const [m, path] of [['get', '/api/products'], ['get', '/api/sales'], ['post', '/api/checkout'], ['get', `/api/sales/${uuid()}`]]) {
      assert.equal((await a.request[m](path)).status, 401, path);
    }
  });

  it('reject cashiers with 403 and change nothing', async () => {
    for (const [m, path, body] of OWNER_ONLY()) {
      const r = await send(a.as(cashier)[m](path), body);
      assert.equal(r.status, 403, `${m} ${path} -> ${r.status}`);
      assert.equal(r.body.error.code, 'FORBIDDEN');
    }
    const st = (await infra.sup.query('select stock_qty, price_centavos, is_active from public.products where id=$1', [product])).rows[0];
    assert.deepEqual(st, { stock_qty: 20, price_centavos: '1000', is_active: true });
    assert.equal((await infra.sup.query(`select is_active from public.profiles where id=$1`, [cashier2])).rows[0].is_active, true);
  });

  it('are available to the owner', async () => {
    for (const path of ['/api/inventory/movements', '/api/inventory/low-stock', '/api/dashboard', '/api/users',
      '/api/reports/daily-sales?from=2030-01-01&to=2030-01-02']) {
      assert.equal((await a.as(owner).get(path)).status, 200, path);
    }
  });
});

describe('product visibility', () => {
  it('cashiers see only active products and never cost prices', async () => {
    const r = await a.as(cashier).get(`/api/products?search=${tag}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.map((p) => p.name), [`${tag} Soap`]);
    assert.equal('cost_centavos' in r.body.data[0], false);
    assert.ok(!JSON.stringify(r.body).includes('cost'));
    const one = await a.as(cashier).get(`/api/products/${product}`);
    assert.equal(one.status, 200);
    assert.equal('cost_centavos' in one.body.data, false);
    assert.equal((await a.as(cashier).get(`/api/products/${archived}`)).status, 404);
    // a cashier cannot widen the filter
    const all = await a.as(cashier).get(`/api/products?search=${tag}&status=all`);
    assert.deepEqual(all.body.data.map((p) => p.name), [`${tag} Soap`]);
  });

  it('the owner sees cost prices and can list archived products', async () => {
    const r = await a.as(owner).get(`/api/products?search=${tag}&status=all`);
    const byName = Object.fromEntries(r.body.data.map((p) => [p.name, p]));
    assert.equal(byName[`${tag} Soap`].cost_centavos, 600);
    assert.equal(byName[`${tag} Archived`].is_active, false);
    assert.equal((await a.as(owner).get(`/api/products?search=${tag}&status=archived`)).body.total, 1);
  });
});

describe('sales visibility', () => {
  let saleA;
  before(async () => {
    const r = await a.as(cashier).post('/api/checkout').send({
      idempotency_key: uuid(), items: [{ product_id: product, qty: 1 }], cash_received_centavos: 1000 });
    assert.equal(r.status, 201);
    saleA = r.body.data.sale_id;
  });

  it("a cashier sees only their own sales; another cashier's sale looks nonexistent (404)", async () => {
    const own = await a.as(cashier).get(`/api/sales/${saleA}`);
    assert.equal(own.status, 200);
    assert.equal(own.body.data.items[0].product_name, `${tag} Soap`);
    assert.equal((await a.as(cashier2).get(`/api/sales/${saleA}`)).status, 404);
    assert.equal((await a.as(cashier2).get(`/api/sales/${uuid()}`)).status, 404);
    const list2 = await a.as(cashier2).get('/api/sales');
    assert.ok(list2.body.data.every((s) => s.id !== saleA));
    const list1 = await a.as(cashier).get('/api/sales');
    assert.ok(list1.body.data.some((s) => s.id === saleA));
  });

  it('the owner sees every sale', async () => {
    assert.equal((await a.as(owner).get(`/api/sales/${saleA}`)).status, 200);
    assert.ok((await a.as(owner).get('/api/sales')).body.data.some((s) => s.id === saleA));
  });

  it('there is no API to edit or delete a sale', async () => {
    for (const who of [owner, cashier]) {
      for (const m of ['put', 'patch', 'delete']) {
        const r = await a.request[m](`/api/sales/${saleA}`).set('Authorization', `Bearer test-${who}`);
        assert.ok([404, 405].includes(r.status) || r.status === 404, `${m} -> ${r.status}`);
      }
    }
    assert.equal((await infra.sup.query('select count(*)::int n from public.sales where id=$1', [saleA])).rows[0].n, 1);
  });
});
