import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { errorHandler, AppError } from './errors.js';
import { makeAuth, makeLimiters } from './middleware.js';
import { productRoutes } from './routes/products.js';
import { salesRoutes } from './routes/sales.js';
import { adminRoutes } from './routes/admin.js';

/** Builds the Express app. db and auth are injected so tests can use a local PostgREST and a fake token verifier. */
export function createApp({ config, db, auth, logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);   // set TRUST_PROXY=1 behind a hosting proxy so rate limits see real IPs

  app.use(helmet());
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
    methods: ['GET', 'POST', 'PUT', 'PATCH'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  }));
  app.use(express.json({ limit: '100kb' }));

  const limiters = makeLimiters(config.rateLimits);
  const mw = { ...makeAuth({ auth, db }), limiters };
  app.use('/api', limiters.general, limiters.failedAuth);

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  const ctx = { db, auth, mw, config, logger };
  app.use('/api', productRoutes(ctx), salesRoutes(ctx), adminRoutes(ctx));

  app.use((req, res, next) => next(new AppError(404, 'NOT_FOUND', 'Not found.')));
  app.use(errorHandler(logger));
  return app;
}
