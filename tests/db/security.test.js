import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { superPool, servicePool, seedUser, mkProduct, checkout, stockOf, count, uuid,
  expectCode, expectPgCode, asAuthenticated, assertStockConsistent, randomPastDay } from './helpers.js';

let sup, svc, owner, cashier, cashier2, inactiveOwner;
before(async () => {
  sup = superPool(); svc = servicePool();
  owner = await seedUser(sup, 'owner');
  cashier = await seedUser(sup, 'cashier');
  cashier2 = await seedUser(sup, 'cashier');
  inactiveOwner = await seedUser(sup, 'owner', { active: false });
});
after(async () => { await assertStockConsistent(sup); await svc.end(); await sup.end(); });

describe('who may call the business functions', () => {
  it('logged-in users and anon cannot execute any of them directly (SQLSTATE 42501)', async () => {
    const p = await mkProduct(svc, owner);
    for (const role of ['authenticated', 'anon']) {
      const uid = role === 'authenticated' ? cashier : '';
      await asAuthenticated(sup, uid, async (c) => {
        await expectPgCode(c.query('select public.checkout_sale($1,$2,$3::jsonb,$4)',
          [cashier, uuid(), JSON.stringify([{ product_id: p, qty: 1 }]), 5000]), '42501');
        await expectPgCode(c.query('select public.adjust_stock($1,$2,5,$3,null)', [cashier, p, 'new_delivery']), '42501');
        await expectPgCode(c.query('select public.create_product($1,$2,null,100,50,1,1)', [owner, 'x']), '42501');
        await expectPgCode(c.query('select public.update_product($1,$2,$3,null,100,50,1,true)', [owner, p, 'x']), '42501');
        await expectPgCode(c.query('select * from public.daily_sales_summary($1,$2,$3)', [owner, '2020-01-01', '2020-01-02']), '42501');
        await expectPgCode(c.query('select public.sale_receipt($1)', [uuid()]), '42501');
      }, role);
    }
    assert.equal(await stockOf(sup, p), 10);
  });

  it('a cashier id cannot perform owner operations even through service_role', async () => {
    const p = await mkProduct(svc, owner);
    await expectCode(svc.query('select public.create_product($1,$2,null,100,50,1,1)', [cashier, 'x']), 'FORBIDDEN');
    await expectCode(svc.query('select public.update_product($1,$2,$3,null,100,50,1,true)', [cashier, p, 'x']), 'FORBIDDEN');
    await expectCode(svc.query('select public.adjust_stock($1,$2,5,$3,null)', [cashier, p, 'new_delivery']), 'FORBIDDEN');
    await expectCode(svc.query('select * from public.daily_sales_summary($1,$2,$3)', [cashier, '2020-01-01', '2020-01-02']), 'FORBIDDEN');
    await expectCode(svc.query('select public.adjust_stock($1,$2,5,$3,null)', [null, p, 'new_delivery']), 'FORBIDDEN');
    assert.equal(await stockOf(sup, p), 10);
  });

  it('deactivated or unknown users cannot act or sell', async () => {
    const p = await mkProduct(svc, owner);
    await expectCode(svc.query('select public.adjust_stock($1,$2,5,$3,null)', [inactiveOwner, p, 'new_delivery']), 'FORBIDDEN');
    const gone = await seedUser(sup, 'cashier', { active: false });
    await expectCode(checkout(svc, gone, uuid(), [{ product_id: p, qty: 1 }], 5000), 'FORBIDDEN');
    await expectCode(checkout(svc, uuid(), uuid(), [{ product_id: p, qty: 1 }], 5000), 'FORBIDDEN');
    assert.equal(await stockOf(sup, p), 10);
  });

  it('an owner may also complete a sale', async () => {
    const p = await mkProduct(svc, owner, { price: 100 });
    const r = await checkout(svc, owner, uuid(), [{ product_id: p, qty: 1 }], 100);
    assert.equal(r.total_centavos, 100);
  });
});

describe('Row Level Security and table privileges', () => {
  let p, ownerSale, cashierSale, cashier2Sale;
  before(async () => {
    p = await mkProduct(svc, owner, { price: 100, cost: 60, stock: 50 });
    ownerSale = await checkout(svc, owner, uuid(), [{ product_id: p, qty: 1 }], 100);
    cashierSale = await checkout(svc, cashier, uuid(), [{ product_id: p, qty: 1 }], 100);
    cashier2Sale = await checkout(svc, cashier2, uuid(), [{ product_id: p, qty: 1 }], 100);
  });

  it('cashier: sees products, NOT cost prices, NOT movements, only own sales/items/profile', async () => {
    await asAuthenticated(sup, cashier, async (c) => {
      assert.equal((await c.query('select count(*)::int n from public.products where id = $1', [p])).rows[0].n, 1);
      assert.equal((await c.query('select count(*)::int n from public.product_costs')).rows[0].n, 0);
      assert.equal((await c.query('select count(*)::int n from public.inventory_movements')).rows[0].n, 0);
      const sales = (await c.query('select txn_no from public.sales')).rows.map((r) => r.txn_no);
      assert.deepEqual(sales, [cashierSale.txn_no]);
      const items = (await c.query('select sale_id from public.sale_items')).rows;
      assert.ok(items.length >= 1 && items.every((i) => i.sale_id === cashierSale.sale_id));
      assert.equal((await c.query('select count(*)::int n from public.profiles')).rows[0].n, 1);
      await expectPgCode(c.query('select * from public.checkout_requests'), '42501');
    });
  });

  it('owner: sees cost prices, movements and every sale', async () => {
    await asAuthenticated(sup, owner, async (c) => {
      const cost = (await c.query('select cost_centavos from public.product_costs where product_id = $1', [p])).rows;
      assert.equal(cost[0].cost_centavos, '60');
      assert.ok((await c.query('select count(*)::int n from public.inventory_movements where product_id=$1', [p])).rows[0].n >= 4);
      const sales = (await c.query('select txn_no from public.sales where id = any($1)',
        [[ownerSale.sale_id, cashierSale.sale_id, cashier2Sale.sale_id]])).rows;
      assert.equal(sales.length, 3);
    });
  });

  it('deactivated owner sees nothing', async () => {
    await asAuthenticated(sup, inactiveOwner, async (c) => {
      assert.equal((await c.query('select count(*)::int n from public.products')).rows[0].n, 0);
      assert.equal((await c.query('select count(*)::int n from public.sales')).rows[0].n, 0);
    });
  });

  it('even an owner session cannot write tables directly (all writes go through functions)', async () => {
    await asAuthenticated(sup, owner, async (c) => {
      await expectPgCode(c.query('update public.products set price_centavos = 1 where id = $1', [p]), '42501');
      await expectPgCode(c.query('update public.products set stock_qty = 9999 where id = $1', [p]), '42501');
      await expectPgCode(c.query('delete from public.sales'), '42501');
      await expectPgCode(c.query('update public.sales set total_centavos = 1'), '42501');
      await expectPgCode(c.query('insert into public.profiles (id, full_name, role) values ($1, $2, $3)', [uuid(), 'x', 'owner']), '42501');
      await expectPgCode(c.query('update public.profiles set role = $2 where id = $1', [cashier, 'owner']), '42501');
    });
  });

  it('service_role cannot edit or delete sales, items, movements or stock with raw SQL either', async () => {
    await expectPgCode(svc.query('update public.sales set total_centavos = 1'), '42501');
    await expectPgCode(svc.query('delete from public.sale_items'), '42501');
    await expectPgCode(svc.query('update public.inventory_movements set delta = 5'), '42501');
    await expectPgCode(svc.query('update public.products set stock_qty = 999 where id = $1', [p]), '42501');
    await expectPgCode(svc.query('delete from public.products where id = $1', [p]), '42501');
    await expectPgCode(svc.query('insert into public.sales (txn_no,cashier_id,total_centavos,cash_received_centavos,change_centavos) values ($1,$2,1,1,0)', ['X', cashier]), '42501');
  });
});

describe('integrity triggers (apply to every role, including the database owner)', () => {
  it('completed sales, items and movements cannot be updated, deleted or truncated', async () => {
    const p = await mkProduct(svc, owner, { price: 100 });
    const r = await checkout(svc, cashier, uuid(), [{ product_id: p, qty: 1 }], 100);
    for (const sql of [
      'update public.sales set total_centavos = 1', 'delete from public.sales',
      'update public.sale_items set qty = 99', 'delete from public.sale_items',
      'update public.inventory_movements set delta = 99', 'delete from public.inventory_movements',
      'truncate public.sales cascade', 'truncate public.sale_items', 'truncate public.inventory_movements',
      'delete from public.checkout_requests', 'update public.checkout_requests set request_hash = \'x\'',
    ]) {
      await expectCode(sup.query(sql), 'IMMUTABLE_RECORD');
    }
    assert.equal(await count(sup, 'sales', 'id = $1', [r.sale_id]), 1);
  });

  it('products cannot be deleted (archive instead)', async () => {
    const p = await mkProduct(svc, owner);
    await expectCode(sup.query('delete from public.products where id = $1', [p]), 'PRODUCTS_CANNOT_BE_DELETED');
    await expectCode(sup.query('truncate public.products cascade'), 'PRODUCTS_CANNOT_BE_DELETED');
  });

  it('stock cannot be edited outside the audited functions, and can never go negative', async () => {
    const p = await mkProduct(svc, owner, { stock: 3 });
    await expectCode(sup.query('update public.products set stock_qty = stock_qty + 1 where id = $1', [p]), 'STOCK_CHANGE_NOT_ALLOWED');
    await expectCode(sup.query(`insert into public.products (name, price_centavos, stock_qty) values ('sneaky', 100, 5)`), 'STOCK_CHANGE_NOT_ALLOWED');
    // Even with the guard flag on, the CHECK constraint is the final backstop.
    const c = await sup.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.stock_change','on',true)`);
      await assert.rejects(c.query('update public.products set stock_qty = -1 where id = $1', [p]),
        (e) => e.code === '23514' && /products_stock_nonneg/.test(e.message));
      await c.query('rollback');
    } finally { c.release(); }
    assert.equal(await stockOf(sup, p), 3);
  });
});

describe('product management and stock adjustment', () => {
  it('creates products with initial stock, audit movement and owner-only cost', async () => {
    const bc = 'BC' + uuid().slice(0, 8);
    const p = await mkProduct(svc, owner, { name: '  Safeguard Soap ', price: 3500, cost: 2800, stock: 12, barcode: ` ${bc} ` });
    const row = (await sup.query('select name, barcode, price_centavos, stock_qty from public.products where id=$1', [p])).rows[0];
    assert.deepEqual(row, { name: 'Safeguard Soap', barcode: bc, price_centavos: '3500', stock_qty: 12 });
    const mv = (await sup.query('select delta, qty_after, reason from public.inventory_movements where product_id=$1', [p])).rows;
    assert.deepEqual(mv, [{ delta: 12, qty_after: 12, reason: 'initial_stock' }]);
  });

  it('rejects duplicate barcodes (case-insensitive) and invalid data with clear codes', async () => {
    const bc = 'ABC-' + uuid().slice(0, 8);
    await mkProduct(svc, owner, { barcode: bc.toUpperCase() });
    await expectCode(mkProduct(svc, owner, { barcode: bc.toLowerCase() }), 'DUPLICATE_BARCODE');
    await expectCode(mkProduct(svc, owner, { price: 0 }), 'INVALID_PRODUCT_DATA');
    await expectCode(mkProduct(svc, owner, { price: -5 }), 'INVALID_PRODUCT_DATA');
    await expectCode(mkProduct(svc, owner, { stock: -1 }), 'INVALID_PRODUCT_DATA');
    await expectCode(mkProduct(svc, owner, { name: '   ' }), 'INVALID_PRODUCT_DATA');
    await expectCode(mkProduct(svc, owner, { cost: -1 }), 'INVALID_PRODUCT_DATA');
  });

  it('update_product changes details but never stock; null cost leaves cost unchanged', async () => {
    const p = await mkProduct(svc, owner, { price: 1000, cost: 700, stock: 8 });
    await svc.query('select public.update_product($1,$2,$3,$4,$5,$6,$7,$8)', [owner, p, 'Renamed', null, 1200, null, 3, true]);
    const row = (await sup.query(`select p.name, p.price_centavos, p.stock_qty, p.low_stock_threshold, c.cost_centavos
                                    from public.products p join public.product_costs c on c.product_id = p.id where p.id=$1`, [p])).rows[0];
    assert.deepEqual(row, { name: 'Renamed', price_centavos: '1200', stock_qty: 8, low_stock_threshold: 3, cost_centavos: '700' });
    await expectCode(svc.query('select public.update_product($1,$2,$3,null,100,null,1,true)', [owner, uuid(), 'x']), 'INVALID_PRODUCT');
  });

  it('adjust_stock: deliveries, damage, counts; every change has a movement and negatives are refused', async () => {
    const p = await mkProduct(svc, owner, { stock: 5 });
    const adj = (d, reason, note = null) => svc.query('select public.adjust_stock($1,$2,$3,$4,$5) as r', [owner, p, d, reason, note]);
    assert.equal((await adj(20, 'new_delivery', 'Puregold run')).rows[0].r.stock_qty, 25);
    assert.equal((await adj(-3, 'damaged')).rows[0].r.stock_qty, 22);
    assert.equal((await adj(-2, 'expired')).rows[0].r.stock_qty, 20);
    assert.equal((await adj(-4, 'stock_count_correction')).rows[0].r.stock_qty, 16);
    assert.equal((await adj(2, 'stock_count_correction')).rows[0].r.stock_qty, 18);
    assert.equal((await adj(1, 'other', 'found one behind the shelf')).rows[0].r.stock_qty, 19);

    await expectCode(adj(-20, 'damaged'), 'NEGATIVE_STOCK');            // would go below zero
    await expectCode(adj(0, 'new_delivery'), 'INVALID_QUANTITY');
    await expectCode(adj(-1, 'new_delivery'), 'INVALID_QUANTITY');      // a delivery cannot remove stock
    await expectCode(adj(1, 'damaged'), 'INVALID_QUANTITY');            // damage cannot add stock
    await expectCode(adj(1, 'other'), 'NOTE_REQUIRED');
    await expectCode(adj(1, 'because'), 'INVALID_REASON');
    await expectCode(adj(1, null), 'INVALID_REASON');
    await expectCode(adj(1, 'new_delivery', 'x'.repeat(501)), 'INVALID_NOTE');
    await expectCode(svc.query('select public.adjust_stock($1,$2,1,$3,null)', [owner, uuid(), 'new_delivery']), 'INVALID_PRODUCT');

    assert.equal(await stockOf(sup, p), 19);
    const mv = await count(sup, 'inventory_movements', 'product_id = $1', [p]);
    assert.equal(mv, 1 + 6);                                             // initial + six accepted changes
    const bad = await sup.query(`select 1 from public.inventory_movements where product_id=$1 and reason='new_delivery' and note='Puregold run'`, [p]);
    assert.equal(bad.rowCount, 1);
  });
});

describe('daily sales totals (Philippine local days)', () => {
  it('groups by Asia/Manila date, including the midnight boundary', async () => {
    const c = await seedUser(sup, 'cashier');
    const { prev: P, day: D, next: N } = randomPastDay();
    // Historic rows inserted by the superuser with explicit timestamps (+08:00 = Manila).
    const ins = (n, ts, total) => sup.query(
      `insert into public.sales (txn_no, cashier_id, total_centavos, cash_received_centavos, change_centavos, created_at)
       values ($1,$2,$3,$3,0,$4)`, [`TEST-${uuid()}-${n}`, c, total, ts]);
    await ins(1, `${P} 23:59:59+08`, 1000);   // last instant of 28 Feb
    await ins(2, `${D} 00:00:00+08`, 2000);   // 1 Mar (first instant)
    await ins(3, `${D} 23:59:59+08`, 3000);   // 1 Mar (last instant)
    await ins(4, `${N} 00:00:00+08`, 4000);   // 2 Mar
    const q = async (a, b) => (await svc.query(
      'select day::text, txn_count::int, total_centavos::text from public.daily_sales_summary($1,$2,$3)', [owner, a, b])).rows;
    assert.deepEqual(await q(`${D}`, `${D}`), [{ day: `${D}`, txn_count: 2, total_centavos: '5000' }]);
    assert.deepEqual(await q(`${P}`, `${N}`), [
      { day: `${N}`, txn_count: 1, total_centavos: '4000' },
      { day: `${D}`, txn_count: 2, total_centavos: '5000' },
      { day: `${P}`, txn_count: 1, total_centavos: '1000' }]);
    assert.deepEqual(await q('2999-01-01', '2999-01-05'), []);
    await expectCode(svc.query('select * from public.daily_sales_summary($1,$2,$3)', [owner, `${N}`, `${D}`]), 'INVALID_DATE_RANGE');
  });

  it("includes a live checkout in today's total", async () => {
    const today = (await sup.query(`select (now() at time zone 'Asia/Manila')::date::text d`)).rows[0].d;
    const read = async () => (await svc.query('select txn_count::int n, total_centavos::bigint t from public.daily_sales_summary($1,$2,$2)',
      [owner, today])).rows[0] ?? { n: 0, t: '0' };
    const before = await read();
    const p = await mkProduct(svc, owner, { price: 1234 });
    await checkout(svc, cashier, uuid(), [{ product_id: p, qty: 3 }], 5000);
    const after_ = await read();
    assert.equal(after_.n - before.n, 1);
    assert.equal(BigInt(after_.t) - BigInt(before.t), 3702n);
  });
});
