import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startInfra, makeApp, seedUser, uuid } from './harness.js';

let infra, a, owner, cashier;
const tag = 'T' + uuid().slice(0, 6);                 // unique prefix so reruns on a used DB do not collide
before(async () => {
  infra = await startInfra(); a = makeApp(infra);
  owner = await seedUser(infra.sup, 'owner', { name: 'Owner Ana' });
  cashier = await seedUser(infra.sup, 'cashier');
});
after(async () => { await infra.stop(); });

const create = (body) => a.as(owner).post('/api/products').send({
  name: `${tag} Item`, price_centavos: 1500, cost_centavos: 1000, initial_stock: 10, low_stock_threshold: 5, ...body });

describe('creating and updating products', () => {
  it('creates a product with stock, cost and an audit movement', async () => {
    const r = await create({ name: `${tag} Lucky Me`, barcode: `${tag}-001` });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.stock_qty, 10);
    assert.equal(r.body.data.cost_centavos, 1000);
    assert.equal(r.body.data.barcode, `${tag}-001`);
    const mv = await a.as(owner).get(`/api/inventory/movements?productId=${r.body.data.id}`);
    assert.equal(mv.body.total, 1);
    assert.equal(mv.body.data[0].reason, 'initial_stock');
    assert.equal(mv.body.data[0].delta, 10);
    assert.equal(mv.body.data[0].product.name, `${tag} Lucky Me`);
    assert.equal(mv.body.data[0].user.full_name, 'Owner Ana');
  });

  it('rejects invalid input with field-level messages (400) and saves nothing', async () => {
    const bad = [
      { name: '' }, { name: '   ' }, { price_centavos: 0 }, { price_centavos: -5 }, { price_centavos: 10.5 },
      { price_centavos: '100' }, { cost_centavos: -1 }, { initial_stock: -1 }, { initial_stock: 1.5 },
      { low_stock_threshold: -2 }, { price_centavos: 100_000_001 }, { name: 'x'.repeat(121) },
      { stock_qty: 50 }, { is_admin: true }, { id: uuid() },
    ];
    for (const b of bad) {
      const r = await create({ name: `${tag} Bad`, ...b });
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.equal(r.body.error.code, 'VALIDATION_ERROR');
      assert.ok(Array.isArray(r.body.error.fields) && r.body.error.fields.length > 0);
    }
    const none = await a.as(owner).get(`/api/products?search=${tag} Bad`);
    assert.equal(none.body.total, 0);
  });

  it('refuses a duplicate barcode (case-insensitive) with 409', async () => {
    await create({ name: `${tag} A`, barcode: `${tag}-DUP` });
    const r = await create({ name: `${tag} B`, barcode: `${tag}-dup` });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'DUPLICATE_BARCODE');
  });

  it('PUT changes details but never stock; omitted cost is left alone', async () => {
    const p = (await create({ name: `${tag} Edit`, price_centavos: 1000, cost_centavos: 700, initial_stock: 8 })).body.data;
    const r = await a.as(owner).put(`/api/products/${p.id}`).send({
      name: `${tag} Edited`, barcode: null, price_centavos: 1200, low_stock_threshold: 2 });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.data.name, r.body.data.price_centavos, r.body.data.stock_qty, r.body.data.cost_centavos, r.body.data.low_stock_threshold],
      [`${tag} Edited`, 1200, 8, 700, 2]);
    const sneaky = await a.as(owner).put(`/api/products/${p.id}`).send({
      name: 'x', barcode: null, price_centavos: 100, low_stock_threshold: 1, stock_qty: 9999 });
    assert.equal(sneaky.status, 400);
    assert.equal((await a.as(owner).get(`/api/products/${p.id}`)).body.data.stock_qty, 8);
    assert.equal((await a.as(owner).put(`/api/products/${uuid()}`).send({
      name: 'x', barcode: null, price_centavos: 100, low_stock_threshold: 1 })).status, 404);
  });

  it('archive hides a product from cashiers; restore brings it back; nothing is deleted', async () => {
    const p = (await create({ name: `${tag} Arch` })).body.data;
    assert.equal((await a.as(owner).post(`/api/products/${p.id}/archive`)).status, 200);
    assert.equal((await a.as(cashier).get(`/api/products?search=${tag} Arch`)).body.total, 0);
    assert.equal((await a.as(owner).get(`/api/products?search=${tag} Arch`)).body.total, 0);        // default = active
    assert.equal((await a.as(owner).get(`/api/products?search=${tag} Arch&status=archived`)).body.total, 1);
    assert.equal((await a.as(owner).post(`/api/products/${p.id}/restore`)).status, 200);
    assert.equal((await a.as(cashier).get(`/api/products?search=${tag} Arch`)).body.total, 1);
    assert.equal((await a.as(owner).post(`/api/products/${uuid()}/archive`)).status, 404);
    const sale = await a.as(cashier).post('/api/checkout').send({ idempotency_key: uuid(), items: [{ product_id: p.id, qty: 1 }], cash_received_centavos: 5000 });
    assert.equal(sale.status, 201);
    await a.as(owner).post(`/api/products/${p.id}/archive`);
    const after_ = await a.as(cashier).post('/api/checkout').send({ idempotency_key: uuid(), items: [{ product_id: p.id, qty: 1 }], cash_received_centavos: 5000 });
    assert.equal(after_.status, 404);                                                              // archived: cannot be sold
    assert.equal((await a.as(owner).get(`/api/sales/${sale.body.data.sale_id}`)).body.data.items[0].product_name, `${tag} Arch`);
  });
});

describe('search and pagination', () => {
  before(async () => {
    for (let i = 1; i <= 5; i++) await create({ name: `${tag} Page ${i}`, barcode: `${tag}-P${i}`, initial_stock: 3 });
  });

  it('pages through results in stable order with a correct total', async () => {
    const seen = [];
    for (const page of [1, 2, 3]) {
      const r = await a.as(owner).get(`/api/products?search=${tag} Page&pageSize=2&page=${page}`);
      assert.equal(r.status, 200);
      assert.equal(r.body.total, 5);
      seen.push(...r.body.data.map((p) => p.name));
    }
    assert.deepEqual(seen, [1, 2, 3, 4, 5].map((i) => `${tag} Page ${i}`));
  });

  it('a page past the end is an empty list, not an error', async () => {
    const r = await a.as(owner).get(`/api/products?search=${tag} Page&pageSize=2&page=50`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data, []);
    assert.equal(r.body.total, 5);
  });

  it('finds by name or barcode, case-insensitively', async () => {
    assert.equal((await a.as(cashier).get(`/api/products?search=${tag.toLowerCase()} PAGE 3`)).body.total, 1);
    const bc = await a.as(cashier).get(`/api/products?search=${tag}-p4`);
    assert.deepEqual(bc.body.data.map((p) => p.barcode), [`${tag}-P4`]);
  });

  it('search text cannot alter the query (filter injection attempts)', async () => {
    const attempts = ['%', '_', '*', '\\', '"', "'", 'a,b)', `zzz"),is_active.eq.false,name.ilike.("*`,
      `x"),id.not.is.null,name.ilike.("`, '(', ')', 'name.eq.1', '; drop table products; --'];
    for (const s of attempts) {
      const r = await a.as(cashier).get('/api/products?pageSize=100&search=' + encodeURIComponent(s));
      assert.equal(r.status, 200, `search ${JSON.stringify(s)} -> ${r.status}`);
      assert.ok(r.body.data.every((p) => p.is_active === true), 'cashier must never see archived products');
    }
    const inj = await a.as(cashier).get('/api/products?search=' + encodeURIComponent(`zzz"),is_active.eq.false,name.ilike.("*`));
    assert.equal(inj.body.total, 0);
    assert.equal((await a.as(cashier).get('/api/products?pageSize=1000')).status, 400);
    assert.equal((await a.as(cashier).get('/api/products?page=0')).status, 400);
  });
});

describe('stock adjustments and low-stock', () => {
  let p;
  before(async () => { p = (await create({ name: `${tag} Stock`, initial_stock: 4, low_stock_threshold: 5 })).body.data; });
  const adjust = (body) => a.as(owner).post(`/api/products/${p.id}/stock-adjustments`).send(body);

  it('new items at or below the threshold show in the low-stock list; a delivery removes the warning', async () => {
    const low = await a.as(owner).get('/api/inventory/low-stock');
    assert.ok(low.body.data.some((x) => x.id === p.id));
    const r = await adjust({ delta: 20, reason: 'new_delivery', note: 'Puregold' });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.stock_qty, 24);
    assert.ok(!(await a.as(owner).get('/api/inventory/low-stock')).body.data.some((x) => x.id === p.id));
  });

  it('records damage/expiry/count corrections with reasons; every change has a movement', async () => {
    assert.equal((await adjust({ delta: -3, reason: 'damaged' })).body.data.stock_qty, 21);
    assert.equal((await adjust({ delta: -1, reason: 'expired', note: 'past date' })).body.data.stock_qty, 20);
    assert.equal((await adjust({ delta: 2, reason: 'stock_count_correction' })).body.data.stock_qty, 22);
    const mv = await a.as(owner).get(`/api/inventory/movements?productId=${p.id}&pageSize=50`);
    assert.deepEqual(mv.body.data.map((m) => [m.reason, m.delta, m.qty_after]).reverse(), [
      ['initial_stock', 4, 4], ['new_delivery', 20, 24], ['damaged', -3, 21], ['expired', -1, 20], ['stock_count_correction', 2, 22]]);
  });

  it('refuses changes that would make stock negative (409) or are invalid (400)', async () => {
    const neg = await adjust({ delta: -999, reason: 'damaged' });
    assert.equal(neg.status, 409);
    assert.equal(neg.body.error.code, 'NEGATIVE_STOCK');
    for (const b of [{ delta: 0, reason: 'damaged' }, { delta: 1.5, reason: 'new_delivery' }, { delta: '5', reason: 'new_delivery' },
      { delta: 5, reason: 'whatever' }, { delta: 5 }, { reason: 'damaged' }, { delta: 5, reason: 'new_delivery', note: 'x'.repeat(501) }]) {
      assert.equal((await adjust(b)).status, 400, JSON.stringify(b));
    }
    const wrongSign = await adjust({ delta: -1, reason: 'new_delivery' });
    assert.equal(wrongSign.status, 400);
    assert.equal(wrongSign.body.error.code, 'INVALID_QUANTITY');
    const noNote = await adjust({ delta: 1, reason: 'other' });
    assert.equal(noNote.body.error.code, 'NOTE_REQUIRED');
    assert.equal((await adjust({ delta: 1, reason: 'new_delivery' }).then(() => a.as(owner).get(`/api/products/${p.id}`))).body.data.stock_qty, 23);
    assert.equal((await a.as(owner).post(`/api/products/${uuid()}/stock-adjustments`).send({ delta: 1, reason: 'new_delivery' })).status, 404);
  });
});
