import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { superPool, servicePool, seedUser, mkProduct, checkout, stockOf, count, uuid,
  expectCode, assertStockConsistent } from './helpers.js';

let sup, svc, owner, c1, c2;
before(async () => {
  sup = superPool(); svc = servicePool(30);
  owner = await seedUser(sup, 'owner'); c1 = await seedUser(sup, 'cashier'); c2 = await seedUser(sup, 'cashier');
});
after(async () => { await assertStockConsistent(sup); await svc.end(); await sup.end(); });

const errCodes = (results) => results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);

describe('concurrent purchases competing for inventory', () => {
  it('15 simultaneous buyers of the LAST unit: exactly one wins, stock never negative', async () => {
    const p = await mkProduct(svc, owner, { price: 500, stock: 1 });
    const results = await Promise.allSettled(Array.from({ length: 15 }, (_, i) =>
      checkout(svc, i % 2 ? c1 : c2, uuid(), [{ product_id: p, qty: 1 }], 500)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.deepEqual([...new Set(errCodes(results))], ['INSUFFICIENT_STOCK']);
    assert.equal(await stockOf(sup, p), 0);
    assert.equal(await count(sup, 'sale_items', 'product_id = $1', [p]), 1);
    assert.equal(await count(sup, 'inventory_movements', "product_id = $1 and reason = 'sale'", [p]), 1);
  });

  it('stock 20, 10 buyers of 3 each: exactly 6 succeed, 2 units left, no oversell', async () => {
    const p = await mkProduct(svc, owner, { price: 100, stock: 20 });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () =>
      checkout(svc, c1, uuid(), [{ product_id: p, qty: 3 }], 300)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 6);
    assert.deepEqual([...new Set(errCodes(results))], ['INSUFFICIENT_STOCK']);
    assert.equal(await stockOf(sup, p), 2);
  });

  it('carts listing the same products in opposite order never deadlock', async () => {
    const a = await mkProduct(svc, owner, { stock: 100 });
    const b = await mkProduct(svc, owner, { stock: 100 });
    const results = await Promise.allSettled(Array.from({ length: 24 }, (_, i) => checkout(svc, c1, uuid(),
      i % 2 ? [{ product_id: a, qty: 1 }, { product_id: b, qty: 1 }]
            : [{ product_id: b, qty: 1 }, { product_id: a, qty: 1 }], 999999)));
    assert.deepEqual(errCodes(results), [], 'no failures (esp. deadlock 40P01) expected');
    assert.equal(await stockOf(sup, a), 76);
    assert.equal(await stockOf(sup, b), 76);
  });
});

describe('duplicate-request protection (idempotency)', () => {
  it('12 simultaneous requests with the SAME key create exactly one sale', async () => {
    const p = await mkProduct(svc, owner, { price: 700, stock: 10 });
    const key = uuid();
    const results = await Promise.allSettled(Array.from({ length: 12 }, () =>
      checkout(svc, c1, key, [{ product_id: p, qty: 1 }], 1000)));
    assert.deepEqual(errCodes(results), []);
    const receipts = results.map((r) => r.value);
    assert.equal(new Set(receipts.map((r) => r.txn_no)).size, 1);
    assert.equal(receipts.filter((r) => r.replayed === false).length, 1);
    assert.equal(receipts.filter((r) => r.replayed === true).length, 11);
    assert.equal(await stockOf(sup, p), 9);
    assert.equal(await count(sup, 'sales', 'id = $1', [receipts[0].sale_id]), 1);
    assert.equal(await count(sup, 'checkout_requests', 'idempotency_key = $1', [key]), 1);
  });

  it('a later repeat returns the original receipt and does not deduct again', async () => {
    const p = await mkProduct(svc, owner, { price: 700, stock: 10 });
    const key = uuid();
    const first = await checkout(svc, c1, key, [{ product_id: p, qty: 2 }], 2000);
    const again = await checkout(svc, c1, key, [{ product_id: p, qty: 2 }], 2000);
    assert.equal(again.replayed, true);
    assert.equal(again.txn_no, first.txn_no);
    assert.equal(again.change_centavos, first.change_centavos);
    assert.equal(await stockOf(sup, p), 8);
  });

  it('the same key with a different cart is refused, not silently reused', async () => {
    const p = await mkProduct(svc, owner, { price: 700, stock: 10 });
    const key = uuid();
    await checkout(svc, c1, key, [{ product_id: p, qty: 1 }], 1000);
    await expectCode(checkout(svc, c1, key, [{ product_id: p, qty: 5 }], 9000), 'IDEMPOTENCY_KEY_REUSED');
    await expectCode(checkout(svc, c1, key, [{ product_id: p, qty: 1 }], 2000), 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(await stockOf(sup, p), 9);
  });

  it('a FAILED attempt does not burn the key; the same key can be used after fixing the problem', async () => {
    const p = await mkProduct(svc, owner, { price: 700, stock: 10 });
    const key = uuid();
    await expectCode(checkout(svc, c1, key, [{ product_id: p, qty: 1 }], 100), 'INSUFFICIENT_CASH');
    const ok = await checkout(svc, c1, key, [{ product_id: p, qty: 1 }], 1000);
    assert.equal(ok.replayed, false);
    assert.equal(await stockOf(sup, p), 9);
  });

  it('keys are scoped per cashier', async () => {
    const p = await mkProduct(svc, owner, { price: 100, stock: 10 });
    const key = uuid();
    const a = await checkout(svc, c1, key, [{ product_id: p, qty: 1 }], 100);
    const b = await checkout(svc, c2, key, [{ product_id: p, qty: 1 }], 100);
    assert.notEqual(a.txn_no, b.txn_no);
    assert.equal(await stockOf(sup, p), 8);
  });

  it('get_checkout_result answers "did it commit?" after an ambiguous failure', async () => {
    const p = await mkProduct(svc, owner, { price: 100, stock: 10 });
    const key = uuid();
    const none = await svc.query('select public.get_checkout_result($1,$2) as r', [c1, key]);
    assert.equal(none.rows[0].r, null);                       // never committed
    const sale = await checkout(svc, c1, key, [{ product_id: p, qty: 1 }], 100);
    const found = await svc.query('select public.get_checkout_result($1,$2) as r', [c1, key]);
    assert.equal(found.rows[0].r.txn_no, sale.txn_no);        // committed
  });
});
