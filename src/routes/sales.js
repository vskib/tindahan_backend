import { Router } from 'express';
import { AppError, fromDbError, unwrap } from '../errors.js';
import { paged } from '../paging.js';
import { validate, idParam, keyParam, checkoutBody, salesQuery, rangeQuery } from '../validation.js';

const SALE_COLS = 'id, txn_no, created_at, total_centavos, cash_received_centavos, change_centavos, cashier:profiles(full_name)';
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// Business days are Philippine local days (UTC+8, no DST).
const dayStart = (ymd) => `${ymd}T00:00:00+08:00`;

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

  return r;
}
