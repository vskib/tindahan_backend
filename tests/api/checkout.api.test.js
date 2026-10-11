import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startInfra, makeApp, seedUser, uuid } from './harness.js';
import { servicePool, mkProduct, stockOf, count, randomPastDay } from '../db/helpers.js';

let infra, a, svc, owner, c1, c2;
before(async () => {
  infra = await startInfra(); a = makeApp(infra); svc = servicePool();
  owner = await seedUser(infra.sup, 'owner');
  c1 = await seedUser(infra.sup, 'cashier', { name: 'Cashier One' });
  c2 = await seedUser(infra.sup, 'cashier');
});
after(async () => { await svc.end(); await infra.stop(); });

const sell = (who, items, cash, key = uuid(), app = a) =>
  app.as(who).post('/api/checkout').send({ idempotency_key: key, items, cash_received_centavos: cash });
const line = (product_id, qty = 1) => ({ product_id, qty });

describe('POST /api/checkout', () => {
  it('completes a cash sale: totals, change, receipt data, stock deducted', async () => {
    const p1 = await mkProduct(svc, owner, { name: 'Pancit Canton', price: 1500, stock: 10 });
    const p2 = await mkProduct(svc, owner, { name: 'Coke Mismo', price: 1050, stock: 5 });
    const r = await sell(c1, [line(p1, 2), line(p2, 3)], 10000);
    assert.equal(r.status, 201);
    const d = r.body.data;
    assert.equal(d.total_centavos, 6150);
    assert.equal(d.cash_received_centavos, 10000);
    assert.equal(d.change_centavos, 3850);
    assert.equal(d.store_name, 'Test Tindahan');
    assert.equal(d.cashier_name, 'Cashier One');
    assert.match(d.txn_no, /^TXN-\d{8}-\d{6}$/);
    assert.deepEqual(d.items.map((i) => [i.product_name, i.qty, i.unit_price_centavos, i.line_total_centavos]),
      [['Coke Mismo', 3, 1050, 3150], ['Pancit Canton', 2, 1500, 3000]]);
    assert.equal(d.replayed, false);
    assert.equal(await stockOf(infra.sup, p1), 8);
    assert.equal(await stockOf(infra.sup, p2), 2);
  });

  it('rejects prices, totals or change sent by the browser (400) and saves nothing', async () => {
    const p = await mkProduct(svc, owner, { price: 2500 });
    const salesBefore = await count(infra.sup, 'sales');
    for (const extra of [{ unit_price: 1 }, { price: 1 }, { total: 1 }, { total_centavos: 1 }, { change_centavos: 0 }]) {
      const r = await a.as(c1).post('/api/checkout').send({ idempotency_key: uuid(),
        items: [{ product_id: p, qty: 1, ...extra }], cash_received_centavos: 2500 });
      assert.equal(r.status, 400, JSON.stringify(extra));
      const r2 = await a.as(c1).post('/api/checkout').send({ idempotency_key: uuid(), items: [line(p)], cash_received_centavos: 2500, ...extra });
      assert.equal(r2.status, 400, JSON.stringify(extra));
    }
    assert.equal(await count(infra.sup, 'sales'), salesBefore);
    assert.equal(await stockOf(infra.sup, p), 10);
  });

  it('rejects malformed carts, quantities, keys and cash (400)', async () => {
    const p = await mkProduct(svc, owner);
    const base = { idempotency_key: uuid(), items: [line(p)], cash_received_centavos: 5000 };
    const bad = [
      { items: [] }, { items: 'x' }, { items: [line(p, 0)] }, { items: [line(p, -1)] }, { items: [line(p, 1.5)] },
      { items: [{ product_id: p, qty: '2' }] }, { items: [{ product_id: 'nope', qty: 1 }] }, { items: [line(p, 10000)] },
      { items: Array.from({ length: 101 }, () => line(p)) }, { idempotency_key: 'not-a-uuid' }, { idempotency_key: undefined },
      { cash_received_centavos: 0 }, { cash_received_centavos: -100 }, { cash_received_centavos: '5000' },
      { cash_received_centavos: 50.5 }, { cash_received_centavos: undefined },
    ];
    for (const b of bad) {
      const r = await a.as(c1).post('/api/checkout').send({ ...base, ...b });
      assert.equal(r.status, 400, JSON.stringify(b).slice(0, 80));
      assert.equal(r.body.error.code, 'VALIDATION_ERROR');
    }
    assert.equal(await stockOf(infra.sup, p), 10);
  });

  it('insufficient cash: 422 with a clear peso message and no changes', async () => {
    const p = await mkProduct(svc, owner, { price: 1000, stock: 5 });
    const before = await count(infra.sup, 'sales');
    const r = await sell(c1, [line(p, 2)], 1999);
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'INSUFFICIENT_CASH');
    assert.match(r.body.error.message, /₱19\.99.*₱20\.00/);
    assert.equal(await count(infra.sup, 'sales'), before);
    assert.equal(await stockOf(infra.sup, p), 5);
  });

  it('insufficient stock: 409 names the product; invalid or archived product: 404', async () => {
    const p = await mkProduct(svc, owner, { name: 'Last Biscuit', price: 500, stock: 2 });
    const r = await sell(c1, [line(p, 3)], 99999);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'INSUFFICIENT_STOCK');
    assert.match(r.body.error.message, /Last Biscuit.*2 available, 3 requested/);
    assert.equal((await sell(c1, [line(uuid())], 99999)).status, 404);
    assert.equal(await stockOf(infra.sup, p), 2);
  });

  it('an owner can also ring up a sale', async () => {
    const p = await mkProduct(svc, owner, { price: 100 });
    assert.equal((await sell(owner, [line(p)], 100)).status, 201);
  });

  it('is rate limited per user', async () => {
    const t = makeApp(infra, { rateLimits: { checkout: { windowMs: 60_000, limit: 3 } } });
    const p = await mkProduct(svc, owner, { price: 100, stock: 50 });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await sell(c1, [line(p)], 100, uuid(), t)).status);
    assert.deepEqual(codes, [201, 201, 201, 429, 429]);
    assert.equal((await sell(c2, [line(p)], 100, uuid(), t)).status, 201);          // another user is unaffected
  });
});

describe('duplicate requests and concurrency through HTTP', () => {
  it('a repeated request returns the original receipt (200, replayed) and deducts stock once', async () => {
    const p = await mkProduct(svc, owner, { price: 700, stock: 10 });
    const key = uuid();
    const first = await sell(c1, [line(p, 2)], 2000, key);
    const again = await sell(c1, [line(p, 2)], 2000, key);
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.equal(again.body.data.replayed, true);
    assert.equal(again.body.data.txn_no, first.body.data.txn_no);
    assert.equal(await stockOf(infra.sup, p), 8);
    const clash = await sell(c1, [line(p, 5)], 9000, key);                          // same key, different cart
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
  });

  it('10 simultaneous double-clicks with the same key create exactly one sale', async () => {
    const p = await mkProduct(svc, owner, { price: 700, stock: 10 });
    const key = uuid();
    const rs = await Promise.all(Array.from({ length: 10 }, () => sell(c1, [line(p)], 1000, key)));
    assert.equal(rs.filter((r) => r.status === 201).length, 1);
    assert.equal(rs.filter((r) => r.status === 200).length, 9);
    assert.equal(new Set(rs.map((r) => r.body.data.txn_no)).size, 1);
    assert.equal(await stockOf(infra.sup, p), 9);
  });

  it('8 cashiers racing for the last unit: one 201, the rest 409, stock never negative', async () => {
    const p = await mkProduct(svc, owner, { price: 500, stock: 1 });
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => sell(i % 2 ? c1 : c2, [line(p)], 500)));
    assert.equal(rs.filter((r) => r.status === 201).length, 1);
    assert.equal(rs.filter((r) => r.status === 409 && r.body.error.code === 'INSUFFICIENT_STOCK').length, 7);
    assert.equal(await stockOf(infra.sup, p), 0);
  });
});

describe('ambiguous network failures never create a false success or a double sale', () => {
  // Simulates the response getting lost on the way back (sale COMMITTED) or the request never arriving.
  const flaky = (mode) => (db) => ({
    from: (t) => db.from(t),
    rpc: async (name, args) => {
      if (name !== 'checkout_sale') return db.rpc(name, args);
      if (mode === 'lost-response') await db.rpc(name, args);                    // the DB commits...
      if (mode === 'db-error') return { data: null, error: { code: '23514', message: 'boom' } };
      return { data: null, error: { code: '', message: 'TypeError: fetch failed' } };  // ...but the answer is lost
    },
  });

  it('response lost AFTER commit: 503 "unknown", status check shows committed, same-key retry replays', async () => {
    const p = await mkProduct(svc, owner, { price: 1000, stock: 10 });
    const lossy = makeApp(infra, { wrapDb: flaky('lost-response') });
    const key = uuid();
    const r = await sell(c1, [line(p, 2)], 5000, key, lossy);
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'CHECKOUT_OUTCOME_UNKNOWN');
    assert.equal(r.body.error.idempotency_key, key);
    assert.equal(r.body.data, undefined, 'must not look like a success');

    const status = await a.as(c1).get(`/api/checkout/${key}`);
    assert.equal(status.body.committed, true);
    assert.equal(status.body.receipt.total_centavos, 2000);
    assert.equal(status.body.receipt.change_centavos, 3000);

    const retry = await sell(c1, [line(p, 2)], 5000, key);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.data.replayed, true);
    assert.equal(retry.body.data.txn_no, status.body.receipt.txn_no);
    assert.equal(await stockOf(infra.sup, p), 8);                                  // deducted exactly once
    assert.equal(await count(infra.sup, 'sales', 'cashier_id = $1 and total_centavos = 2000 and txn_no = $2', [c1, retry.body.data.txn_no]), 1);
  });

  it('request lost BEFORE commit: status check says not committed; retrying the same key then succeeds once', async () => {
    const p = await mkProduct(svc, owner, { price: 1000, stock: 10 });
    const lossy = makeApp(infra, { wrapDb: flaky('lost-request') });
    const key = uuid();
    assert.equal((await sell(c1, [line(p)], 5000, key, lossy)).status, 503);
    const status = await a.as(c1).get(`/api/checkout/${key}`);
    assert.deepEqual(status.body, { committed: false, receipt: null });
    assert.equal(await stockOf(infra.sup, p), 10);
    const retry = await sell(c1, [line(p)], 5000, key);
    assert.equal(retry.status, 201);
    assert.equal(await stockOf(infra.sup, p), 9);
  });

  it('a database error (SQLSTATE present) is reported as a definite failure, not "unknown"', async () => {
    const p = await mkProduct(svc, owner, { price: 1000, stock: 10 });
    const bad = makeApp(infra, { wrapDb: flaky('db-error') });
    const r = await sell(c1, [line(p)], 5000, uuid(), bad);
    assert.equal(r.status, 500);
    assert.equal(r.body.error.code, 'CHECKOUT_FAILED');
    assert.ok(!JSON.stringify(r.body).includes('boom'));
  });

  it("status lookups are private: one cashier cannot see another's checkout", async () => {
    const p = await mkProduct(svc, owner, { price: 100 });
    const key = uuid();
    await sell(c1, [line(p)], 100, key);
    assert.equal((await a.as(c2).get(`/api/checkout/${key}`)).body.committed, false);
    assert.equal((await a.as(c1).get('/api/checkout/not-a-uuid')).status, 400);
  });
});

describe('sales history, receipts and daily totals', () => {
  it('historical receipts stay accurate after the product is renamed, repriced and archived', async () => {
    const p = await mkProduct(svc, owner, { name: 'Before Name', price: 1000, stock: 10 });
    const sale = (await sell(c1, [line(p, 2)], 5000)).body.data;
    await a.as(owner).put(`/api/products/${p}`).send({ name: 'After Name', barcode: null, price_centavos: 9900, low_stock_threshold: 1 });
    await a.as(owner).post(`/api/products/${p}/archive`);
    for (const who of [c1, owner]) {
      const r = await a.as(who).get(`/api/sales/${sale.sale_id}`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.data.items.map((i) => [i.product_name, i.unit_price_centavos, i.qty, i.line_total_centavos]),
        [['Before Name', 1000, 2, 2000]]);
      assert.equal(r.body.data.total_centavos, 2000);
      assert.equal(r.body.data.change_centavos, 3000);
      assert.equal(r.body.data.cashier.full_name, 'Cashier One');
    }
  });

  it("the owner's daily total and the dashboard move by exactly the new sale", async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
    const read = async () => {
      const d = (await a.as(owner).get(`/api/reports/daily-sales?from=${today}&to=${today}`)).body.data[0] ?? { txn_count: 0, total_centavos: 0 };
      const dash = (await a.as(owner).get('/api/dashboard')).body.data;
      return { n: Number(d.txn_count), t: Number(d.total_centavos), dash };
    };
    const before = await read();
    const p = await mkProduct(svc, owner, { price: 1234, stock: 10 });
    const sale = (await sell(c1, [line(p, 3)], 5000)).body.data;
    const after_ = await read();
    assert.equal(after_.n - before.n, 1);
    assert.equal(after_.t - before.t, 3702);
    assert.equal(after_.dash.today_transactions - before.dash.today_transactions, 1);
    assert.equal(after_.dash.today_total_centavos - before.dash.today_total_centavos, 3702);
    assert.equal(after_.dash.date, today);
    assert.ok(after_.dash.recent_sales.some((s) => s.txn_no === sale.txn_no));
    assert.ok(after_.dash.active_products >= 1);
  });

  it('date filters use Philippine days, including the midnight boundary', async () => {
    const who = await seedUser(infra.sup, 'cashier');
    const { prev: P, day: D, next: N } = randomPastDay();
    const ins = (ts, total) => infra.sup.query(`insert into public.sales (txn_no, cashier_id, total_centavos, cash_received_centavos, change_centavos, created_at)
      values ($1,$2,$3,$3,0,$4)`, [`T-${uuid()}`, who, total, ts]);
    await ins(`${P} 23:59:59+08`, 100);
    await ins(`${D} 00:00:00+08`, 200);
    await ins(`${D} 23:59:59+08`, 300);
    await ins(`${N} 00:00:00+08`, 400);
    const q = async (qs) => (await a.as(who).get('/api/sales?' + qs)).body;
    assert.deepEqual((await q(`from=${D}&to=${D}`)).data.map((s) => s.total_centavos).sort(), [200, 300]);
    assert.equal((await q(`from=${D}`)).total, 3);
    assert.equal((await q(`to=${P}`)).total, 1);
    assert.equal((await q(`from=${P}&to=${N}&pageSize=2&page=2`)).data.length, 2);
    for (const bad of ['from=2026-13-40', 'from=yesterday', 'to=2026-2-1', `from=${N}&to=${D}`]) {
      assert.equal((await a.as(who).get('/api/sales?' + bad)).status, 400, bad);
    }
  });
});
