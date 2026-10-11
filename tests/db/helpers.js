import pg from 'pg';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const BASE = process.env.TEST_PG_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432';
export const DB_NAME = 'tindahan_test';
export const adminUrl = `${BASE}/postgres`;
export const dbUrl = `${BASE}/${DB_NAME}`;

/** Superuser pool: used for fixtures and for inspecting tables. */
export const superPool = (max = 5) => new pg.Pool({ connectionString: dbUrl, max });
/** Pool whose connections run as the Supabase service_role (what the Express backend uses). */
export const servicePool = (max = 25) =>
  new pg.Pool({ connectionString: dbUrl, max, options: '-c role=service_role' });

export const uuid = randomUUID;

export async function seedUser(sup, role, { active = true, name } = {}) {
  const id = randomUUID();
  await sup.query('insert into auth.users (id, email) values ($1, $2)', [id, `${id}@test.local`]);
  await sup.query('insert into public.profiles (id, full_name, role, is_active) values ($1,$2,$3,$4)',
    [id, name ?? `${role} ${id.slice(0, 4)}`, role, active]);
  return id;
}

export async function mkProduct(svc, owner, { name = 'Item ' + randomUUID().slice(0, 6), price = 1000, cost = 500,
  stock = 10, threshold = 5, barcode = null } = {}) {
  const { rows } = await svc.query('select public.create_product($1,$2,$3,$4,$5,$6,$7) as r',
    [owner, name, barcode, price, cost, stock, threshold]);
  return rows[0].r.id;
}

export async function checkout(svc, cashier, key, items, cash) {
  const { rows } = await svc.query('select public.checkout_sale($1,$2,$3::jsonb,$4) as r',
    [cashier, key, JSON.stringify(items), cash]);
  return rows[0].r;
}

export const stockOf = async (sup, id) =>
  (await sup.query('select stock_qty from public.products where id = $1', [id])).rows[0].stock_qty;

export const count = async (sup, table, where = 'true', params = []) =>
  Number((await sup.query(`select count(*) c from public.${table} where ${where}`, params)).rows[0].c);

/** Assert the promise rejects with our machine-readable error code (the exception message). */
export async function expectCode(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.message, code, `expected ${code} but got ${e.code}/${e.message}`);
    return true;
  });
}
export async function expectPgCode(promise, sqlstate) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, sqlstate, `expected SQLSTATE ${sqlstate} but got ${e.code}/${e.message}`);
    return true;
  });
}

/** Run fn with a connection acting as a logged-in Supabase user (RLS applies). */
export async function asAuthenticated(sup, userId, fn, role = 'authenticated') {
  const c = await sup.connect();
  try {
    await c.query(`set role ${role}`);
    await c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId ?? '']);
    return await fn(c);
  } finally {
    await c.query('reset role');
    await c.query(`select set_config('request.jwt.claim.sub', '', false)`);
    c.release();
  }
}

/** Every product's stock must equal the sum of its movements. */
export async function assertStockConsistent(sup) {
  const { rows } = await sup.query(`
    select p.id, p.stock_qty, coalesce(sum(m.delta), 0)::int as moved
      from public.products p left join public.inventory_movements m on m.product_id = p.id
     group by p.id having p.stock_qty <> coalesce(sum(m.delta), 0)`);
  assert.deepEqual(rows, [], 'stock_qty does not match inventory_movements');
}

/** A random calendar day between 2001 and 2018 (Manila is a fixed +08:00 then) plus its neighbours, as YYYY-MM-DD.
 *  Historic fixtures sort BELOW real recent sales, and random days keep reruns on a used database from colliding. */
export function randomPastDay() {
  const base = Date.UTC(2001, 0, 2) + Math.floor(Math.random() * 365 * 18) * 86_400_000;
  const f = (ms) => new Date(ms).toISOString().slice(0, 10);
  return { prev: f(base - 86_400_000), day: f(base), next: f(base + 86_400_000) };
}
