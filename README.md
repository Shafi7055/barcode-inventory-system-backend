# Barcode Inventory API

Express API for local development with the Next.js frontend. It has no authentication and binds only to `127.0.0.1`; it must not be deployed or exposed to a network. See [`API-DESIGN.md`](./API-DESIGN.md) and [`openapi.json`](./openapi.json) for the endpoint contract.

## Requirements

- Node.js 20+
- PostgreSQL

## Local setup

1. Copy `.env.example` to `.env` and configure `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` (or set `DATABASE_URL`).
2. Create the PostgreSQL database named in `DB_NAME` or `DATABASE_URL`.
3. Run `npm install`, then `npm run db:setup`.
4. Run `npm run dev`; the API listens on port 4000 by default.
5. In the frontend, copy `.env.local.example` to `.env.local` and run its `npm run dev`.

## Routes

All application routes are under `/api/v1`. `GET /health` checks the database connection. Requests are restricted by CORS to `FRONTEND_ORIGIN`; this is not authentication or a substitute for access control.
