import 'dotenv/config';
import { loadConfig } from './config.js';
import { createSupabaseDeps } from './supabase.js';
import { createApp } from './app.js';

const config = loadConfig();
const { db, auth } = createSupabaseDeps(config);
const app = createApp({ config, db, auth });

const server = app.listen(config.port, () => {
  console.log(`API listening on port ${config.port} (${config.env}); allowed origins: ${config.corsOrigins.join(', ')}`);
});
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message ?? e));
