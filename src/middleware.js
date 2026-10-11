import { rateLimit } from 'express-rate-limit';
import { AppError, unwrap } from './errors.js';

const limited = { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment and try again.' } };

export function makeLimiters(cfg) {
  const base = { standardHeaders: 'draft-7', legacyHeaders: false, message: limited };
  return {
    general: rateLimit({ ...base, ...cfg.general }),
    // Slows down token guessing / probing: only 401/403 responses are counted, per IP.
    failedAuth: rateLimit({
      ...base, ...cfg.failedAuth, skipSuccessfulRequests: true,
      requestWasSuccessful: (req, res) => res.statusCode !== 401 && res.statusCode !== 403,
    }),
    checkout: rateLimit({ ...base, ...cfg.checkout, keyGenerator: (req) => req.user?.id ?? 'anon' }),
    admin: rateLimit({ ...base, ...cfg.admin, keyGenerator: (req) => req.user?.id ?? 'anon' }),
  };
}

export function makeAuth({ auth, db }) {
  const requireAuth = async (req, res, next) => {
    const m = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(req.get('authorization') ?? '');
    if (!m || m[1].length > 4096) throw new AppError(401, 'UNAUTHENTICATED', 'Please log in.');
    let identity;
    try {
      identity = await auth.verifyToken(m[1]);
    } catch {
      throw new AppError(503, 'AUTH_UNAVAILABLE', 'Login service is temporarily unavailable. Please try again.');
    }
    if (!identity) throw new AppError(401, 'SESSION_EXPIRED', 'Your session has expired. Please log in again.');

    // Role and active flag come from our own database on EVERY request, never from the token.
    const profile = unwrap(await db.from('profiles').select('id, full_name, role, is_active')
      .eq('id', identity.id).maybeSingle());
    if (!profile) throw new AppError(403, 'NO_PROFILE', 'This account is not set up for the store system.');
    if (!profile.is_active) throw new AppError(403, 'ACCOUNT_DISABLED', 'This account has been disabled.');
    req.user = profile;
    next();
  };
  const requireOwner = (req, res, next) => {
    if (req.user?.role !== 'owner') throw new AppError(403, 'FORBIDDEN', 'Only the owner can do that.');
    next();
  };
  return { requireAuth, requireOwner };
}
