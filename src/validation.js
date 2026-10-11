import { z } from 'zod';
import { AppError } from './errors.js';

export const validate = (schemas) => (req, res, next) => {
  req.valid = {};
  for (const part of ['params', 'query', 'body']) {
    if (!schemas[part]) continue;
    const input = part === 'body' ? (req.body ?? {}) : req[part];
    const r = schemas[part].safeParse(input);
    if (!r.success) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Please check the form and try again.', {
        fields: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    req.valid[part] = r.data;
  }
  next();
};

const id = z.guid();
const int = (min, max) => z.number().int().min(min).max(max);       // no coercion: "5" and 5.5 are rejected
const centavos = int(1, 100_000_000);                                // up to PHP 1,000,000.00
const name = z.string().trim().min(1, 'Required').max(120);
const barcode = z.string().trim().max(64).nullable().transform((v) => (v ? v : null));
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}, 'Not a real date');

export const idParam = z.object({ id });
export const keyParam = z.object({ key: id });

export const pageQuery = {
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};
export const productListQuery = z.object({
  ...pageQuery,
  search: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'archived', 'all']).default('active'),
});
export const movementsQuery = z.object({ ...pageQuery, productId: id.optional() });
export const salesQuery = z.object({ ...pageQuery, from: ymd.optional(), to: ymd.optional() });
export const rangeQuery = z.object({ from: ymd, to: ymd });

export const productCreate = z.strictObject({
  name,
  barcode: barcode.optional(),
  price_centavos: centavos,
  cost_centavos: int(0, 100_000_000),
  initial_stock: int(0, 1_000_000).default(0),
  low_stock_threshold: int(0, 1_000_000).default(5),
});
// PUT is a full replace of these fields. Stock is NOT editable here; use stock adjustments.
export const productUpdate = z.strictObject({
  name,
  barcode,
  price_centavos: centavos,
  cost_centavos: int(0, 100_000_000).optional(),
  low_stock_threshold: int(0, 1_000_000),
});
export const stockAdjustment = z.strictObject({
  delta: int(-1_000_000, 1_000_000).refine((n) => n !== 0, 'Cannot be zero'),
  reason: z.enum(['new_delivery', 'damaged', 'expired', 'stock_count_correction', 'other']),
  note: z.string().trim().max(500).optional(),
});

// Strict on purpose: prices or totals sent by the browser are rejected, not silently ignored.
export const checkoutBody = z.strictObject({
  idempotency_key: id,
  items: z.array(z.strictObject({ product_id: id, qty: int(1, 9999) })).min(1).max(100),
  cash_received_centavos: int(1, 100_000_000_000),
});

export const userCreate = z.strictObject({
  email: z.email().max(254),
  password: z.string().min(10, 'At least 10 characters').max(72),
  full_name: z.string().trim().min(1).max(100),
});
export const userUpdate = z.strictObject({
  full_name: z.string().trim().min(1).max(100).optional(),
  is_active: z.boolean().optional(),
}).refine((v) => v.full_name !== undefined || v.is_active !== undefined, 'Nothing to update');
