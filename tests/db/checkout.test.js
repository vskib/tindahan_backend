import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { superPool, servicePool, seedUser, mkProduct, checkout, stockOf, count, uuid,
  expectCode, assertStockConsistent } from './helpers.js';

let sup, svc, owner, cashier;
before(async () => {
  sup = superPool(); svc = servicePool();
  owner = await seedUser(sup, 'owner'); cashier = await seedUser(sup, 'cashier');
});
after(async () => { await assertStockConsistent(sup); await svc.end(); await sup.end(); });

describe('successful cash checkout', () => {
  it('computes total/change, deducts stock, stores items and movements', async () => {
    const p1 = await mkProduct(svc, owner, { name: 'Lucky Me Pancit Canton', price: 1500, stock: 10 });
    const p2 = await mkProduct(svc, owner, { name: 'Coke Mismo', price: 1050, stock: 5 });
    const r = await checkout(svc, cashier, uuid(), [{ product_id: p1, qty: 2 }, { product_id: p2, qty: 3 }], 10000);
    assert.equal(r.total_centavos, 2 * 1500 + 3 * 1050);           // 6150
    assert.equal(r.cash_received_centavos, 10000);
    assert.equal(r.change_centavos, 10000 - 6150);                  // 3850
    assert.match(r.txn_no, /^TXN-\d{8}-\d{6}$/);
    assert.equal(r.replayed, false);
    assert.equal(r.items.length, 2);
    assert.equal(await stockOf(sup, p1), 8);
    assert.equal(await stockOf(sup, p2), 2);
    const mv = (await sup.query(`select product_id, delta, qty_after, reason from public.inventory_movements
                                  where sale_id = $1 order by delta`, [r.sale_id])).rows;
    assert.deepEqual(mv.map((m) => [m.delta, m.qty_after, m.reason]), [[-3, 2, 'sale'], [-2, 8, 'sale']]);
  });

  it('exact cash gives zero change', async () => {
    const p = await mkProduct(svc, owner, { price: 2500 });
    const r = await checkout(svc, cashier, uuid(), [{ product_id: p, qty: 1 }], 2500);
    assert.equal(r.change_centavos, 0);
  });

  it('ignores prices/totals sent by the browser', async () => {
    const p = await mkProduct(svc, owner, { price: 2500 });
    const r = await checkout(svc, cashier, uuid(),
      [{ product_id: p, qty: 1, unit_price: 1, price: 1, total: 1 }], 2500);
    assert.equal(r.total_centavos, 2500);
    assert.equal(r.items[0].unit_price_centavos, 2500);
  });

  it('merges duplicate product lines into one sale item', async () => {
    const p = await mkProduct(svc, owner, { price: 100, stock: 10 });
    const r = await checkout(svc, cashier, uuid(), [{ product_id: p, qty: 2 }, { product_id: p, qty: 3 }], 500);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].qty, 5);
    assert.equal(await stockOf(sup, p), 5);
  });
});

describe('rejections leave no trace', () => {
  async function snapshot() {
    return [await count(sup, 'sales'), await count(sup, 'sale_items'),
      await count(sup, 'inventory_movements'), await count(sup, 'checkout_requests')];
  }

  it('insufficient cash', async () => {
    const p = await mkProduct(svc, owner, { price: 1000, stock: 5 });
    const before = await snapshot();
    await expectCode(checkout(svc, cashier, uuid(), [{ product_id: p, qty: 2 }], 1999), 'INSUFFICIENT_CASH');
    assert.deepEqual(await snapshot(), before);
    assert.equal(await stockOf(sup, p), 5);
  });

  it('insufficient stock reports which product', async () => {
    const p = await mkProduct(svc, owner, { name: 'Last One', price: 1000, stock: 2 });
    const before = await snapshot();
    await assert.rejects(checkout(svc, cashier, uuid(), [{ product_id: p, qty: 3 }], 99999), (e) => {
      assert.equal(e.message, 'INSUFFICIENT_STOCK');
      const d = JSON.parse(e.detail);
      assert.equal(d.available, 2); assert.equal(d.requested, 3); assert.equal(d.name, 'Last One');
      return true;
    });
    assert.deepEqual(await snapshot(), before);
    assert.equal(await stockOf(sup, p), 2);
  });

  it('malformed carts and quantities', async () => {
    const p = await mkProduct(svc, owner);
    const bad = [[], 'x', {}, [{ product_id: p, qty: 0 }], [{ product_id: p, qty: -1 }],
      [{ product_id: p, qty: 1.5 }], [{ product_id: p, qty: '2' }], [{ product_id: p }],
      [{ qty: 1 }], [{ product_id: 'not-a-uuid', qty: 1 }], [{ product_id: p, qty: 10000 }], [null], [1]];
    for (const items of bad) {
      await expectCode(checkout(svc, cashier, uuid(), items, 100000), 'INVALID_CART');
    }
    await expectCode(checkout(svc, cashier, uuid(), [{ product_id: p, qty: 1 }], 0), 'INVALID_CASH');
    await expectCode(checkout(svc, cashier, uuid(), [{ product_id: p, qty: 1 }], -5), 'INVALID_CASH');
    assert.equal(await stockOf(sup, p), 10);
  });

  it('unknown and archived products', async () => {
    const p = await mkProduct(svc, owner);
    await expectCode(checkout(svc, cashier, uuid(), [{ product_id: uuid(), qty: 1 }], 99999), 'INVALID_PRODUCT');
    await svc.query('select public.update_product($1,$2,$3,$4,$5,$6,$7,$8)',
      [owner, p, 'Archived', null, 1000, null, 5, false]);
    await expectCode(checkout(svc, cashier, uuid(), [{ product_id: p, qty: 1 }], 99999), 'INVALID_PRODUCT');
  });

  it('a cart where only the LAST line is short changes nothing (all-or-nothing)', async () => {
    const a = await mkProduct(svc, owner, { stock: 10 });
    const b = await mkProduct(svc, owner, { stock: 10 });
    const c = await mkProduct(svc, owner, { stock: 1 });
    const before = await snapshot();
    await expectCode(checkout(svc, cashier, uuid(),
      [{ product_id: a, qty: 1 }, { product_id: b, qty: 1 }, { product_id: c, qty: 5 }], 999999), 'INSUFFICIENT_STOCK');
    assert.deepEqual(await snapshot(), before);
    for (const [id, s] of [[a, 10], [b, 10], [c, 1]]) assert.equal(await stockOf(sup, id), s);
  });
});

describe('full rollback after a failure in the middle of the write phase', () => {
  before(async () => {
    await sup.query(`create table public.test_fail_products (product_id uuid primary key)`);
    await sup.query(`create function public.test_fail_movement() returns trigger language plpgsql security definer as $$
      begin
        if exists (select 1 from public.test_fail_products where product_id = new.product_id) then
          raise exception 'INJECTED_FAILURE';
        end if;
        return new;
      end $$`);
    await sup.query(`create trigger zz_test_fail before insert on public.inventory_movements
      for each row execute function public.test_fail_movement()`);
  });
  after(async () => {
    await sup.query('drop trigger zz_test_fail on public.inventory_movements');
    await sup.query('drop function public.test_fail_movement()');
    await sup.query('drop table public.test_fail_products');
  });

  it('sale, items, stock, movements and idempotency claim are all rolled back', async () => {
    const ids = [await mkProduct(svc, owner, { stock: 10 }), await mkProduct(svc, owner, { stock: 10 })].sort();
    // Fails on the second line processed (ids are processed in sorted order), i.e. AFTER the sale header,
    // all sale_items, and the first stock deduction + movement have already been written.
    await sup.query('insert into public.test_fail_products values ($1)', [ids[1]]);
    const before = [await count(sup, 'sales'), await count(sup, 'sale_items'),
      await count(sup, 'inventory_movements'), await count(sup, 'checkout_requests')];
    const key = uuid();
    await assert.rejects(checkout(svc, cashier, key, ids.map((product_id) => ({ product_id, qty: 2 })), 999999),
      /INJECTED_FAILURE/);
    const after_ = [await count(sup, 'sales'), await count(sup, 'sale_items'),
      await count(sup, 'inventory_movements'), await count(sup, 'checkout_requests')];
    assert.deepEqual(after_, before);
    assert.equal(await stockOf(sup, ids[0]), 10);
    assert.equal(await stockOf(sup, ids[1]), 10);
    // The key was not consumed: after the fault clears, the same key succeeds.
    await sup.query('delete from public.test_fail_products');
    const r = await checkout(svc, cashier, key, ids.map((product_id) => ({ product_id, qty: 2 })), 999999);
    assert.equal(r.replayed, false);
    assert.equal(await stockOf(sup, ids[0]), 8);
  });
});

describe('historical receipts', () => {
  it('stay accurate after the product is renamed, repriced and archived', async () => {
    const p = await mkProduct(svc, owner, { name: 'Old Name', price: 1000, stock: 10 });
    const key = uuid();
    const r1 = await checkout(svc, cashier, key, [{ product_id: p, qty: 2 }], 5000);
    await svc.query('select public.update_product($1,$2,$3,$4,$5,$6,$7,$8)',
      [owner, p, 'New Name', null, 9900, null, 5, false]);
    const { rows } = await svc.query('select public.get_checkout_result($1,$2) as r', [cashier, key]);
    const r2 = rows[0].r;
    assert.equal(r2.items[0].product_name, 'Old Name');
    assert.equal(r2.items[0].unit_price_centavos, 1000);
    assert.equal(r2.total_centavos, 2000);
    assert.equal(r2.change_centavos, 3000);
    assert.equal(r2.txn_no, r1.txn_no);
    const row = (await sup.query('select product_name, unit_price_centavos from public.sale_items where sale_id=$1',
      [r1.sale_id])).rows[0];
    assert.deepEqual(row, { product_name: 'Old Name', unit_price_centavos: '1000' });
  });
});
