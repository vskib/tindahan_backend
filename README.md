# Che’s Tindahan backend

## Local setup

1. Install Node.js 20 or newer.
2. Set the Supabase project URL, service role key, and frontend origin in `.env`.
3. Run `npm ci`, then `npm start`.

The service role key has full database access. Keep it on the backend host, out of source control, browser variables, and support messages. Production frontend origins must use HTTPS and be listed exactly in `CORS_ORIGINS`.

## Database setup

The API expects its Supabase schema, row policies, and database functions to be installed before use. This checkout does not include the `../supabase/migrations` directory referenced by the test setup, so a database cannot be initialized from this repository as provided.
