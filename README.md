# Che’s Tindahan backend

## Local setup

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and set the Supabase project URL, service role key, and frontend origin.
3. Run `npm ci`, then `npm start`.

The service role key has full database access. Keep it on the backend host, out of source control, browser variables, and support messages. Production frontend origins must use HTTPS and be listed exactly in `CORS_ORIGINS`.

## Database and tests

The API expects its Supabase schema, row policies, and database functions to be installed before use. This checkout does not include the `../supabase/migrations` directory referenced by the test setup, so a database cannot be initialized from this repository as provided.

The `npm test` script recreates a local database whose name must end in `_test`; never point it at a production database. It also requires PostgreSQL and PostgREST.
