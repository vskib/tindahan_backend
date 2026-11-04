import { Router } from 'express';
import { AppError, fromDbError, unwrap } from '../errors.js';
import { paged } from '../paging.js';
import { validate, idParam, keyParam, checkoutBody, salesQuery, rangeQuery, periodSalesQuery } from '../validation.js';

const SALE_COLS = 'id, txn_no, created_at, total_centavos, cash_received_centavos, change_centavos, cashier:profiles(full_name)';
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// Business days are Philippine local days (UTC+8, no DST).
const dayStart = (ymd) => `${ymd}T00:00:00+08:00`;
const manilaDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(iso));
const periodStart = (ymd, period) => {
  if (period === 'month') return `${ymd.slice(0, 7)}-01`;
  const date = new Date(`${ymd}T00:00:00Z`);
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  return addDays(ymd, -mondayOffset);
};

export function salesRoutes({ db, mw, config, logger }) {
  const r = Router();
  const { requireAuth, requireOwner } = mw;
  const withStore = (receipt) => ({ ...receipt, store_name: config.storeName });

  // ---- Checkout: the browser sends only product ids, quantities, cash and an idempotency key. ----
  r.post('/checkout', requireAuth, mw.limiters.checkout, validate({ body: checkoutBody }), async (req, res) => {
    const b = req.valid.body;
    const { data, error } = await db.rpc('checkout_sale', {
      p_cashier_id: req.user.id, p_idempotency_key: b.idempotency_key,
      p_items: b.items, p_cash_received_centavos: b.cash_received_centavos,
    });
    if (error) {
      const known = fromDbError(error);
      if (known) throw known;                                   // clean business rejection: nothing was saved
      logger.error('[checkout] failed', error.code || '(no code)', error.message);
      if (/^[0-9A-Z]{5}$/.test(error.code ?? '')) {
        // The database raised an error, so the transaction rolled back: no sale was recorded.
        throw new AppError(500, 'CHECKOUT_FAILED', 'The sale could not be completed and nothing was saved. Please try again.');
      }
      // Network/gateway failure: the sale may or may not have committed. Never guess; never auto-retry.
      throw new AppError(503, 'CHECKOUT_OUTCOME_UNKNOWN',
        'We could not confirm whether this sale was saved. Do not start it again yet: check the sale status first.',
        { idempotency_key: b.idempotency_key });
    }
    res.status(data.replayed ? 200 : 201).json({ data: withStore(data) });
  });

  // "Did my checkout commit?" Only committed sales are visible. committed:false means nothing is saved so far;
  // if the original request is still running, re-sending the SAME key waits for it and returns that sale.
  r.get('/checkout/:key', requireAuth, validate({ params: keyParam }), async (req, res) => {
    const receipt = unwrap(await db.rpc('get_checkout_result', {
      p_cashier_id: req.user.id, p_idempotency_key: req.valid.params.key }));
    res.json({ committed: receipt != null, receipt: receipt ? withStore(receipt) : null });
  });

  // ---- Sales history ----
  r.get('/sales', requireAuth, validate({ query: salesQuery }), async (req, res) => {
    const { page, pageSize, from, to } = req.valid.query;
    if (from && to && to < from) throw new AppError(400, 'INVALID_DATE_RANGE', 'The end date is before the start date.');
    const build = () => {
      let q = db.from('sales').select(SALE_COLS, { count: 'exact' });
      if (req.user.role !== 'owner') q = q.eq('cashier_id', req.user.id);   // cashiers: their own sales only
      if (from) q = q.gte('created_at', dayStart(from));
      if (to) q = q.lt('created_at', dayStart(addDays(to, 1)));
      return q.order('created_at', { ascending: false }).order('id');
    };
    const { data, total } = await paged(build, page, pageSize);
    res.json({ data, page, pageSize, total });
  });

  r.get('/sales/:id', requireAuth, validate({ params: idParam }), async (req, res) => {
    let q = db.from('sales').select(`${SALE_COLS}, items:sale_items(product_id, product_name, qty, unit_price_centavos, line_total_centavos)`)
      .eq('id', req.valid.params.id);
    if (req.user.role !== 'owner') q = q.eq('cashier_id', req.user.id);
    const row = unwrap(await q.maybeSingle());
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Sale not found.');   // same answer whether it exists or not
    row.items.sort((a, b) => a.product_name.localeCompare(b.product_name));
    res.json({ data: withStore(row) });
  });

  r.get('/reports/daily-sales', requireAuth, requireOwner, validate({ query: rangeQuery }), async (req, res) => {
    const { from, to } = req.valid.query;
    const rows = unwrap(await db.rpc('daily_sales_summary', { p_actor: req.user.id, p_from: from, p_to: to }));
    res.json({ data: rows });
  });

  r.get('/reports/period-sales', requireAuth, validate({ query: periodSalesQuery }), async (req, res) => {
    const { from, to, period } = req.valid.query;
    const owner = req.user.role === 'owner';
    if (to < from) throw new AppError(400, 'INVALID_DATE_RANGE', 'The end date is before the start date.');

    const totals = new Map();
    const pageSize = 100;
    for (let offset = 0; ; offset += pageSize) {
      let query = db.from('sales').select('id, created_at, total_centavos')
        .gte('created_at', dayStart(from)).lt('created_at', dayStart(addDays(to, 1)));
      if (req.user.role !== 'owner') query = query.eq('cashier_id', req.user.id);
      const sales = unwrap(await query.order('created_at').order('id').range(offset, offset + pageSize - 1));
      if (sales.length === 0) break;

      const saleIds = sales.map((sale) => sale.id);
      const saleItems = saleIds.length
        ? unwrap(await db.from('sale_items').select('sale_id, product_id, qty').in('sale_id', saleIds))
        : [];
      // Cost data is private to owners. Cashiers may see their own sales summary,
      // but their response must never include cost-derived margin information.
      const productCosts = owner && saleItems.length
        ? unwrap(await db.from('product_costs').select('product_id, cost_centavos')
          .in('product_id', [...new Set(saleItems.map((item) => item.product_id))]))
        : [];
      const productCostMap = new Map(productCosts.map((row) => [row.product_id, Number(row.cost_centavos || 0)]));
      const itemQtyBySale = new Map();
      const saleCostBySale = new Map();
      const saleCostCompleteBySale = new Map(sales.map((sale) => [sale.id, true]));
      for (const item of saleItems) {
        const qty = Number(item.qty || 0);
        itemQtyBySale.set(item.sale_id, (itemQtyBySale.get(item.sale_id) ?? 0) + qty);
        if (owner) {
          const cost = productCostMap.get(item.product_id);
          // A zero cost is how the product form records an unknown cost.
          if (cost == null || cost <= 0) saleCostCompleteBySale.set(item.sale_id, false);
          else saleCostBySale.set(item.sale_id, (saleCostBySale.get(item.sale_id) ?? 0) + qty * cost);
        }
      }

      for (const sale of sales) {
        const bucket = periodStart(manilaDate(sale.created_at), period);
        const qtySold = itemQtyBySale.get(sale.id) ?? 0;
        const costComplete = owner && saleCostCompleteBySale.get(sale.id) === true && qtySold > 0;
        const estimatedGrossProfit = costComplete
          ? Number(sale.total_centavos) - (saleCostBySale.get(sale.id) ?? 0)
          : null;
        const total = totals.get(bucket) ?? {
          txn_count: 0, total_centavos: 0, qty_sold: 0,
          estimated_gross_profit_centavos: 0, profit_complete: true,
        };
        total.txn_count += 1;
        total.total_centavos += Number(sale.total_centavos);
        total.qty_sold += qtySold;
        if (owner) {
          if (!costComplete) {
            total.profit_complete = false;
            total.estimated_gross_profit_centavos = null;
          } else if (total.profit_complete) {
            total.estimated_gross_profit_centavos += estimatedGrossProfit;
          }
        }
        totals.set(bucket, total);
      }
      if (sales.length < pageSize) break;
    }

    const data = [...totals].sort(([a], [b]) => a.localeCompare(b))
      .map(([period_start, total]) => {
        const row = { period_start, txn_count: total.txn_count, total_centavos: total.total_centavos, qty_sold: total.qty_sold };
        if (owner) {
          row.estimated_gross_profit_centavos = total.estimated_gross_profit_centavos;
          row.profit_complete = total.profit_complete;
        }
        return row;
      });
    let inventory = null;
    if (req.user.role === 'owner') {
      const inventoryPageSize = 1000;
      const products = [];
      for (let offset = 0; ; offset += inventoryPageSize) {
        const page = unwrap(await db.from('products')
          .select('id, name, stock_qty, is_active')
          .order('name').order('id')
          .range(offset, offset + inventoryPageSize - 1));
        products.push(...page);
        if (page.length < inventoryPageSize) break;
      }

      const endBoundary = dayStart(addDays(to, 1));
      const endBoundaryMs = Date.parse(endBoundary);
      const movementsByProduct = new Map();
      for (let offset = 0; ; offset += inventoryPageSize) {
        const page = unwrap(await db.from('inventory_movements')
          .select('product_id, delta, created_at')
          .gte('created_at', dayStart(from))
          .order('created_at').order('id')
          .range(offset, offset + inventoryPageSize - 1));
        for (const movement of page) {
          const totals = movementsByProduct.get(movement.product_id) ?? { since_start: 0, since_end: 0 };
          const delta = Number(movement.delta);
          totals.since_start += delta;
          if (Date.parse(movement.created_at) >= endBoundaryMs) totals.since_end += delta;
          movementsByProduct.set(movement.product_id, totals);
        }
        if (page.length < inventoryPageSize) break;
      }

      const inventoryProducts = products.map((product) => {
        const current_qty = Number(product.stock_qty);
        const movements = movementsByProduct.get(product.id) ?? { since_start: 0, since_end: 0 };
        return {
          id: product.id,
          name: product.name,
          is_active: product.is_active,
          starting_qty: current_qty - movements.since_start,
          ending_qty: current_qty - movements.since_end,
          current_qty,
        };
      });
      inventory = {
        starting_date: from,
        ending_date: to,
        starting_units: inventoryProducts.reduce((sum, product) => sum + product.starting_qty, 0),
        ending_units: inventoryProducts.reduce((sum, product) => sum + product.ending_qty, 0),
        current_units: inventoryProducts.reduce((sum, product) => sum + product.current_qty, 0),
        products: inventoryProducts,
      };
    }
    res.json({ data, inventory });
  });

  return r;
}
