# Barcode Inventory API

The versioned API under `/api/v1` connects the local Next.js frontend to PostgreSQL. The machine-readable endpoint contract is [`openapi.json`](./openapi.json).

## Local-only operation

This API intentionally has no login, sessions, or role checks. It binds to `127.0.0.1` and refuses to start with `NODE_ENV=production`. Do not expose it to a network, deploy it, or use it for sensitive production data. CORS is not authentication.

All writes are attributed to a single `Local operator` audit actor. The database setup removes password, email, username, and role data, anonymizes old user names, and drops the roles table while retaining inventory history.

## Integration conventions

- Base URL: `http://127.0.0.1:4000/api/v1`; configure it with `NEXT_PUBLIC_API_BASE_URL`.
- Send and receive JSON using `Content-Type: application/json`.
- Lists use `{ "data": [...], "meta": { "page", "pageSize", "totalItems", "totalPages" } }`. Defaults are page 1 and 25 items; maximum page size is 100.
- Errors use `{ "error": { "code", "message", "requestId", "details" } }`. Show field-level `details` for `422`; do not treat an error response as a successful empty result.
- Inventory writes (`/receipts`, `/deliveries`, and reversals) require an `Idempotency-Key` for each user action. The service applies inventory changes and transaction records atomically.
- Timestamps are ISO 8601 UTC. Summary dates are inclusive calendar dates; use `timeZone` for a business-local day.

## Frontend screen mapping

| Frontend screen | API |
| --- | --- |
| Dashboard | `GET /dashboard` |
| Component tracking | `POST /component-tracking` |
| Receive stock | `GET /products`, `GET /stock-points?type=RECEIVE`, `POST /receipts` |
| Deliver stock | `GET /stock-points?type=DELIVERY`, `POST /deliveries` |
| Products / components | `GET` and `POST /products` or `/components` |
| Receive / delivery points | `GET` and `POST /stock-points` with the corresponding type |
| Reversals | `POST /transactions/{transactionId}/reversals` |
| Stock details | `GET /reports/stock-details` |
| Summary report | `GET /reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD` |
| Barcode history | `GET /reports/barcode-history?barcode=...` |
| Audit logs | `GET /audit-logs` |

## Data model

The schema keeps product/component catalog codes separate from scanned barcodes. Receiving requires a product and receive point; a new product instance is created for an unseen barcode. Receive and delivery point types are `RECEIVE` and `DELIVERY`; product-instance statuses are `IN_STOCK` and `DELIVERED`.

## Run locally

1. Copy `.env.example` to `.env` and set `DATABASE_URL`.
2. Create the PostgreSQL database named in `DATABASE_URL`.
3. Run `npm run db:setup` to initialize the schema and local operator.
4. Run `npm run dev` in the backend folder.
5. Copy the frontend's `.env.local.example` to `.env.local`, then run `npm run dev` in the frontend folder.
