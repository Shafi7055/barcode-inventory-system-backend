# Barcode Inventory API

Express API for the Next.js frontend with PostgreSQL-backed login, sessions, and role authorization. It binds only to `127.0.0.1` and remains for local development; see [`API-DESIGN.md`](./API-DESIGN.md) and [`openapi.json`](./openapi.json) for the endpoint contract.

## Requirements

- Node.js 20+
- PostgreSQL

## Local setup

1. Copy `.env.example` to `.env` and configure `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` (or set `DATABASE_URL`).
2. Create the PostgreSQL database named in `DB_NAME` or `DATABASE_URL`.
3. Run `npm install`, then `npm run db:setup`. The API creates its tables in the isolated `barcode_inventory` schema and preserves the `public` schema.
4. If the database has no active Admin, set `BOOTSTRAP_ADMIN_USERNAME` and a private `BOOTSTRAP_ADMIN_PASSWORD` of at least 12 characters in `.env` before setup. No default credentials are created.
5. Run `npm run dev`; the API listens on port 4001 by default.
6. In the frontend, copy `.env.local.example` to `.env.local` and run `npm run dev -- --port 3002`.

## Routes

All application routes are under `/api/v1`. `GET /health` checks the database connection. Sign-in sets a signed, HttpOnly, SameSite session cookie; the API reloads each user's active state and role for protected requests without storing sessions in a database table. Registration is limited to the read-only Report Viewer role. Admins create and manage operational accounts through the users API.

## Server structure

- `index.js` is the process entry point; `src/app.js` configures Express middleware and mounts the API.
- `src/routes/` maps HTTP routes to controllers.
- `src/controllers/` handles authentication, user management, dashboard, catalog, inventory, and report requests.
- `src/services/` contains shared transactional inventory operations.
- `src/middleware/` contains session authentication, permission checks, request IDs, and error handling.
- `src/utils/` contains validation and pagination helpers.
- `db.js` owns the PostgreSQL connection pool.

