import { Router } from 'express';
import { AppError, unwrap } from '../errors.js';
import { paged } from '../paging.js';
import {
  validate, idParam, productListQuery, movementsQuery, productCreate, productUpdate, stockAdjustment,
} from '../validation.js';

const PRODUCT_COLS = 'id, name, barcode, price_centavos, stock_qty, low_stock_threshold, is_active, created_at, updated_at';

/** Keep only characters that are safe inside a PostgREST filter value (no commas, parens, quotes, wildcards). */
export const cleanSearch = (s) => s.replace(/[^\p{L}\p{N} .\-'&/#]/gu, '').trim();

export function productRoutes({ db, mw }) {
  const r = Router();
  const { requireAuth, requireOwner } = mw;

  async function withCosts(rows) {
    if (rows.length === 0) return rows;
    const costs = unwrap(await db.from('product_costs').select('product_id, cost_centavos')
      .in('product_id', rows.map((p) => p.id)));
    const map = new Map(costs.map((c) => [c.product_id, c.cost_centavos]));
    return rows.map((p) => ({ ...p, cost_centavos: map.get(p.id) ?? null }));
  }

  r.get('/products', requireAuth, validate({ query: productListQuery }), async (req, res) => {
    const { page, pageSize, search, status } = req.valid.query;
    const owner = req.user.role === 'owner';
    const effective = owner ? status : 'active';          // cashiers never see archived products
    const term = search ? cleanSearch(search) : '';
    const build = () => {
      let q = db.from('products').select(PRODUCT_COLS, { count: 'exact' });
      if (effective === 'active') q = q.eq('is_active', true);
      if (effective === 'archived') q = q.eq('is_active', false);
      if (term) q = q.or(`name.ilike."*${term}*",barcode.ilike."*${term}*"`);
      return q.order('name').order('id');
    };
    const { data, total } = await paged(build, page, pageSize);
    res.json({ data: owner ? await withCosts(data) : data, page, pageSize, total });
  });

  r.get('/products/:id', requireAuth, validate({ params: idParam }), async (req, res) => {
    const owner = req.user.role === 'owner';
    let q = db.from('products').select(PRODUCT_COLS).eq('id', req.valid.params.id);
    if (!owner) q = q.eq('is_active', true);
    const row = unwrap(await q.maybeSingle());
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Product not found.');
    res.json({ data: owner ? (await withCosts([row]))[0] : row });
  });

  r.post('/products', requireAuth, requireOwner, validate({ body: productCreate }), async (req, res) => {
    const b = req.valid.body;
    const out = unwrap(await db.rpc('create_product', {
      p_actor: req.user.id, p_name: b.name, p_barcode: b.barcode ?? null, p_price_centavos: b.price_centavos,
      p_cost_centavos: b.cost_centavos, p_initial_stock: b.initial_stock, p_low_stock_threshold: b.low_stock_threshold,
    }));
    const row = unwrap(await db.from('products').select(PRODUCT_COLS).eq('id', out.id).single());
    res.status(201).json({ data: (await withCosts([row]))[0] });
  });

  r.put('/products/:id', requireAuth, requireOwner, validate({ params: idParam, body: productUpdate }), async (req, res) => {
    const b = req.valid.body;
    const { id } = req.valid.params;
    unwrap(await db.rpc('update_product', {
      p_actor: req.user.id, p_product_id: id, p_name: b.name, p_barcode: b.barcode, p_price_centavos: b.price_centavos,
      p_cost_centavos: b.cost_centavos ?? null, p_low_stock_threshold: b.low_stock_threshold, p_is_active: null,
    }));
    const row = unwrap(await db.from('products').select(PRODUCT_COLS).eq('id', id).single());
    res.json({ data: (await withCosts([row]))[0] });
  });

  for (const [path, active] of [['archive', false], ['restore', true]]) {
    r.post(`/products/:id/${path}`, requireAuth, requireOwner, validate({ params: idParam }), async (req, res) => {
      const out = unwrap(await db.rpc('set_product_active', {
        p_actor: req.user.id, p_product_id: req.valid.params.id, p_is_active: active }));
      res.json({ data: out });
    });
  }

  r.post('/products/:id/stock-adjustments', requireAuth, requireOwner,
    validate({ params: idParam, body: stockAdjustment }), async (req, res) => {
      const b = req.valid.body;
      const out = unwrap(await db.rpc('adjust_stock', {
        p_actor: req.user.id, p_product_id: req.valid.params.id, p_delta: b.delta, p_reason: b.reason, p_note: b.note ?? null }));
      res.status(201).json({ data: out });
    });

  r.get('/inventory/movements', requireAuth, requireOwner, validate({ query: movementsQuery }), async (req, res) => {
    const { page, pageSize, productId } = req.valid.query;
    const build = () => {
      let q = db.from('inventory_movements').select(
        'id, delta, qty_after, reason, note, sale_id, created_at, product:products(id, name), user:profiles(full_name)',
        { count: 'exact' });
      if (productId) q = q.eq('product_id', productId);
      return q.order('created_at', { ascending: false }).order('id');
    };
    const { data, total } = await paged(build, page, pageSize);
    res.json({ data, page, pageSize, total });
  });

  r.get('/inventory/low-stock', requireAuth, requireOwner, async (req, res) => {
    const { data, error, count } = await db.from('low_stock_products').select('*', { count: 'exact' })
      .order('stock_qty').order('name').limit(200);
    unwrap({ error });
    res.json({ data, total: count ?? 0 });
  });

  return r;
}
