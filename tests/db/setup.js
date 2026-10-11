// Creates a fresh test database and applies the Supabase stub + all migrations in order.
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminUrl, dbUrl, DB_NAME } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migDir = path.resolve(here, '../../../supabase/migrations');

if (!DB_NAME.endsWith('_test')) throw new Error('Refusing to run: test database name must end with _test');

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`drop database if exists ${DB_NAME} with (force)`);
await admin.query(`create database ${DB_NAME}`);
await admin.end();

const c = new pg.Client({ connectionString: dbUrl });
await c.connect();
await c.query(fs.readFileSync(path.join(here, 'stub_supabase.sql'), 'utf8'));
for (const f of fs.readdirSync(migDir).filter((n) => n.endsWith('.sql')).sort()) {
  await c.query(fs.readFileSync(path.join(migDir, f), 'utf8'));
  console.log('applied', f);
}
await c.end();
