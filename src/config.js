import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20, 'looks too short to be a real key'),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  STORE_NAME: z.string().trim().min(1).max(80).default('Aking Tindahan'),
});

/** Validate environment variables once at startup and fail fast with a readable message. */
export function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  let origins = e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (e.NODE_ENV !== 'production' && origins.length === 0) origins = ['http://localhost:5173'];
  if (origins.includes('*')) throw new Error('CORS_ORIGINS must list exact origins; "*" is not allowed.');
  if (e.NODE_ENV === 'production') {
    if (origins.length === 0) throw new Error('CORS_ORIGINS is required in production.');
    const bad = origins.filter((o) => !o.startsWith('https://'));
    if (bad.length) throw new Error(`CORS_ORIGINS must use https in production: ${bad.join(', ')}`);
  }
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    supabaseUrl: e.SUPABASE_URL,
    serviceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
    corsOrigins: origins,
    trustProxy: e.TRUST_PROXY,
    storeName: e.STORE_NAME,
    rateLimits: {
      general:    { windowMs: 60_000,      limit: 300 },  // per IP
      failedAuth: { windowMs: 15 * 60_000, limit: 30 },   // per IP, only 401/403 responses count
      checkout:   { windowMs: 60_000,      limit: 60 },   // per user
      admin:      { windowMs: 15 * 60_000, limit: 30 },   // per user: account management
    },
  };
}
