import { Router } from 'express';
import { AppError, unwrap } from '../errors.js';
import { validate, idParam, userCreate, userUpdate } from '../validation.js';

const manilaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());

export function adminRoutes({ db, auth, mw, config, logger }) {
  const r = Router();
  const { requireAuth, requireOwner } = mw;

  r.get('/me', requireAuth, (req, res) => {
    const { id, full_name, role } = req.user;
    res.json({ data: { id, full_name, role, store_name: config.storeName } });
  });

  r.get('/dashboard', requireAuth, requireOwner, async (req, res) => {
    const today = manilaToday();
    const [daily, activeProducts, low, recent] = await Promise.all([
      db.rpc('daily_sales_summary', { p_actor: req.user.id, p_from: today, p_to: today }),
      db.from('products').select('id', { count: 'exact', head: true }).eq('is_active', true),
      db.from('low_stock_products').select('*', { count: 'exact' }).order('stock_qty').order('name').limit(10),
      db.from('sales').select('id, txn_no, created_at, total_centavos, cashier:profiles(full_name)')
        .order('created_at', { ascending: false }).limit(10),
    ]);
    const todayRow = unwrap(daily)[0];
    unwrap({ error: activeProducts.error }); unwrap({ error: low.error }); unwrap({ error: recent.error });
    res.json({ data: {
      date: today,
      today_total_centavos: Number(todayRow?.total_centavos ?? 0),
      today_transactions: Number(todayRow?.txn_count ?? 0),
      active_products: activeProducts.count ?? 0,
      low_stock_count: low.count ?? 0,
      low_stock: low.data,
      recent_sales: recent.data,
    } });
  });

  // ---- Account management (owner only) ----
  r.get('/users', requireAuth, requireOwner, async (req, res) => {
    const rows = unwrap(await db.from('profiles').select('id, full_name, role, is_active, created_at').order('created_at'));
    const emails = await Promise.all(rows.map((p) => auth.getEmail(p.id).catch(() => null)));
    res.json({ data: rows.map((p, i) => ({ ...p, email: emails[i] })) });
  });

  r.post('/users', requireAuth, requireOwner, mw.limiters.admin, validate({ body: userCreate }), async (req, res) => {
    const { email, password, full_name } = req.valid.body;
    const id = await auth.createUser({ email, password, full_name });
    const { error } = await db.from('profiles').insert({ id, full_name, role: 'cashier' });
    if (error) {
      await Promise.resolve(auth.deleteUser(id)).catch((e) => logger.error('[users] cleanup failed', e?.message));
      logger.error('[users] profile insert failed', error.code, error.message);
      throw new AppError(500, 'INTERNAL_ERROR', 'The account could not be created. Please try again.');
    }
    res.status(201).json({ data: { id, email, full_name, role: 'cashier', is_active: true } });
  });

  r.patch('/users/:id', requireAuth, requireOwner, mw.limiters.admin,
    validate({ params: idParam, body: userUpdate }), async (req, res) => {
      const { id } = req.valid.params;
      const { full_name, is_active } = req.valid.body;
      if (id === req.user.id && is_active === false) {
        throw new AppError(400, 'CANNOT_DISABLE_SELF', 'You cannot disable your own account.');
      }
      const patch = {};
      if (full_name !== undefined) patch.full_name = full_name;
      if (is_active !== undefined) patch.is_active = is_active;
      const { data, error } = await db.from('profiles').update(patch).eq('id', id).select('id, full_name, role, is_active').maybeSingle();
      unwrap({ error });
      if (!data) throw new AppError(404, 'NOT_FOUND', 'Account not found.');
      if (is_active !== undefined) {
        // Also stop the account from signing in again. Requests are already blocked by the is_active check.
        await Promise.resolve(auth.setBanned(id, !is_active)).catch((e) => logger.error('[users] ban update failed', e?.message));
      }
      res.json({ data });
    });

  return r;
}
