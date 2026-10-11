import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { superPool, servicePool, seedUser, mkProduct, uuid, expectCode, expectPgCode, asAuthenticated,
  assertStockConsistent } from './helpers.js';

let sup, svc, owner, cashier;
before(async () => {
  sup = superPool(); svc = servicePool();
  owner = await seedUser(sup, 'owner'); cashier = await seedUser(sup, 'cashier');
});
after(async () => { await assertStockConsistent(sup); await svc.end(); await sup.end(); });

const isActive = async (id) => (await sup.query('select is_active from public.products where id=$1', [id])).rows[0].is_active;

describe('migration 005: archive/restore and update_product', () => {
  it('set_product_active archives and restores; owner only; validates input', async () => {
    const p = await mkProduct(svc, owner);
    await svc.query('select public.set_product_active($1,$2,false)', [owner, p]);
    assert.equal(await isActive(p), false);
    await svc.query('select public.set_product_active($1,$2,true)', [owner, p]);
    assert.equal(await isActive(p), true);
    await expectCode(svc.query('select public.set_product_active($1,$2,false)', [cashier, p]), 'FORBIDDEN');
    await expectCode(svc.query('select public.set_product_active($1,$2,null)', [owner, p]), 'INVALID_PRODUCT_DATA');
    await expectCode(svc.query('select public.set_product_active($1,$2,false)', [owner, uuid()]), 'INVALID_PRODUCT');
    await asAuthenticated(sup, owner, (c) =>
      expectPgCode(c.query('select public.set_product_active($1,$2,false)', [owner, p]), '42501'));
  });

  it('update_product with is_active = null leaves the archive status unchanged', async () => {
    const p = await mkProduct(svc, owner);
    await svc.query('select public.set_product_active($1,$2,false)', [owner, p]);
    await svc.query('select public.update_product($1,$2,$3,null,500,null,2,null)', [owner, p, 'Still archived']);
    assert.equal(await isActive(p), false);
    await svc.query('select public.update_product($1,$2,$3,null,500,null,2,true)', [owner, p, 'Now active']);
    assert.equal(await isActive(p), true);
  });
});

describe('migration 005: low_stock_products view', () => {
  it('lists active products at or below their threshold only', async () => {
    const low = await mkProduct(svc, owner, { stock: 3, threshold: 5 });
    const edge = await mkProduct(svc, owner, { stock: 5, threshold: 5 });
    const fine = await mkProduct(svc, owner, { stock: 6, threshold: 5 });
    const arch = await mkProduct(svc, owner, { stock: 1, threshold: 5 });
    await svc.query('select public.set_product_active($1,$2,false)', [owner, arch]);
    const ids = (await svc.query('select id from public.low_stock_products')).rows.map((r) => r.id);
    assert.ok(ids.includes(low) && ids.includes(edge));
    assert.ok(!ids.includes(fine) && !ids.includes(arch));
  });

  it('is readable by signed-in users (RLS applies) but not by anon', async () => {
    await asAuthenticated(sup, cashier, async (c) => { await c.query('select * from public.low_stock_products'); });
    await asAuthenticated(sup, '', (c) => expectPgCode(c.query('select * from public.low_stock_products'), '42501'), 'anon');
    const stranger = await seedUser(sup, 'cashier', { active: false });
    await asAuthenticated(sup, stranger, async (c) => {
      assert.equal((await c.query('select count(*)::int n from public.low_stock_products')).rows[0].n, 0);
    });
  });
});
