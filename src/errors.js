export class AppError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const peso = (centavos) => '₱' + (Number(centavos) / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function parseDetail(error) {
  try { return JSON.parse(error.details ?? ''); } catch { return {}; }
}

// Business error codes raised by the database functions (SQLSTATE P0001, code in the message).
const BUSINESS = {
  FORBIDDEN: () => [403, 'You are not allowed to do that.'],
  INVALID_CART: () => [400, 'The cart is not valid.'],
  INVALID_CASH: () => [400, 'The cash amount is not valid.'],
  INVALID_QUANTITY: () => [400, 'That quantity is not valid for this change.'],
  INVALID_REASON: () => [400, 'Please choose a valid reason.'],
  NOTE_REQUIRED: () => [400, 'Please add a note explaining this change.'],
  INVALID_NOTE: () => [400, 'The note is too long (500 characters maximum).'],
  INVALID_PRODUCT_DATA: () => [400, 'The product details are not valid.'],
  INVALID_DATE_RANGE: () => [400, 'The date range is not valid.'],
  INVALID_PRODUCT: () => [404, 'That product was not found or is no longer available.'],
  DUPLICATE_BARCODE: () => [409, 'Another product already uses this barcode/SKU.'],
  IDEMPOTENCY_KEY_REUSED: () => [409, 'This checkout request was already used with different items. Start a new sale.'],
  INSUFFICIENT_STOCK: (d) => [409, d.name
    ? `Not enough stock for "${d.name}": ${d.available} available, ${d.requested} requested.`
    : 'Not enough stock to complete this sale.'],
  NEGATIVE_STOCK: (d) => [409, `That would make stock negative (${d.available} in stock).`],
  INSUFFICIENT_CASH: (d) => [422, d.total_centavos
    ? `Cash received (${peso(d.cash_received_centavos)}) is less than the total (${peso(d.total_centavos)}).`
    : 'Cash received is less than the total.'],
};

/** Convert a Supabase/PostgREST error into an AppError if it is a known business error, else null. */
export function fromDbError(error) {
  if (!error || error.code !== 'P0001') return null;
  const build = BUSINESS[error.message];
  if (!build) return null;
  const detail = parseDetail(error);
  const [status, message] = build(detail);
  const extra = { ...(detail.product_id ? { product_id: detail.product_id } : {}) };
  return new AppError(status, error.message, message, extra);
}

/** Throw a safe AppError for any database error; unknown errors become a generic 500 (logged, never shown). */
export function unwrap({ data, error }) {
  if (error) {
    const known = fromDbError(error);
    if (known) throw known;
    const e = new AppError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
    e.cause = error;
    throw e;
  }
  return data;
}

export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (err instanceof AppError) {
      if (err.status >= 500) logger.error('[api]', err.code, err.cause?.message ?? err.message);
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'BAD_JSON', message: 'The request body is not valid JSON.' } });
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'The request is too large.' } });
    }
    logger.error('[api] unhandled', err?.stack ?? err);          // stack stays in server logs only
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } });
  };
}
