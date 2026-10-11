import { unwrap } from './errors.js';

/**
 * Run a paginated query. `build` must return a FRESH query each call (with count: 'exact').
 * PostgREST answers 416 (PGRST103) when the requested page starts past the last row; we return an empty page
 * with the real total instead of an error.
 */
export async function paged(build, page, pageSize) {
  const from = (page - 1) * pageSize;
  const first = await build().range(from, from + pageSize - 1);
  if (first.error?.code === 'PGRST103') {
    const head = await build().range(0, 0);
    unwrap(head);
    return { data: [], total: head.count ?? 0 };
  }
  unwrap(first);
  return { data: first.data, total: first.count ?? 0 };
}
