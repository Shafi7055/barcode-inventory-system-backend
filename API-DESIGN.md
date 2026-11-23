# Barcode Inventory API

The versioned API under `/api/v1` connects the Next.js frontend to PostgreSQL. The frontend proxies same-origin `/api/v1` requests to the backend so the session cookie remains first-party. The machine-readable endpoint contract is [`openapi.json`](./openapi.json).

The full assignment scope, role matrix, workflows, and current feature status are documented in the frontend's [project feature specification](../barcode-inventory-system/PROJECT-FEATURES.md).

## Authentication and local operation

The API binds to `127.0.0.1` and refuses to start with `NODE_ENV=production`; it is for local development only and must not be exposed to a network or used for production data. `GET /health` is public. Other inventory and user-management routes require an active session created by `POST /auth/login`. The API stores only a SHA-256 hash of the random session token and sets the token in an HttpOnly, SameSite=Lax cookie. User active status and role are checked on every request.

The fixed roles are `Admin`, `Component Tracker`, `Receive User`, `Delivery User`, and `Report Viewer`. Role authorization is enforced by API middleware; the frontend navigation is only a usability layer. Public registration creates Report Viewer accounts only. Admins can create accounts, assign any fixed role, and deactivate users; role changes and deactivation revoke active sessions. Password changes also revoke sessions. The API uses the isolated PostgreSQL schema `barcode_inventory` and leaves existing objects in `public` untouched. A fresh database requires `BOOTSTRAP_ADMIN_USERNAME` and a 12-character `BOOTSTRAP_ADMIN_PASSWORD`; no default password is supplied.

| Role | API capabilities |
| --- | --- |
| Admin | Dashboard, all inventory operations, product component requirements, reports, audit logs, user management, and reversals |
| Component Tracker | Component tracking, component reads, and own tracked-product activity |
| Receive User | Product reads, receive-point reads, per-component receiving, and own received-product activity |
| Delivery User | Delivery-point reads, delivery, and own delivered-product activity |
| Report Viewer | Read-only reports |

Activity lists are paginated. Admins can view all tracked, received, and delivered products; operational roles can view only activity attributed to their own account. The server applies this scope from the authenticated session.

All writes are attributed to the authenticated user. Login, logout, registration, password changes, and user changes are recorded in the audit log.

## Integration conventions

- Frontend API base: same-origin `/api/v1`, rewritten to `API_SERVER_ORIGIN` (default `http://127.0.0.1:4000`).
- Frontend port: `3000` by default; backend HTTP port: `4000` by default. Set `FRONTEND_ORIGIN` to `http://localhost:3000`.
- PostgreSQL port: configure separately with `DB_PORT` (commonly `5432`); this is not the backend HTTP `PORT`.
- Session: send the HttpOnly cookie set by login; the frontend's same-origin API proxy forwards it automatically.
- Send and receive JSON using `Content-Type: application/json`.
- Lists use `{ "data": [...], "meta": { "page", "pageSize", "totalItems", "totalPages" } }`. Defaults are page 1 and 25 items; maximum page size is 100.
- Errors use `{ "error": { "code", "message", "requestId", "details" } }`. Show field-level `details` for `422`; do not treat an error response as a successful empty result.
- Inventory writes (`/receipts`, `/deliveries`, and reversals) use database transactions. An optional `Idempotency-Key` serializes concurrent writes by user and key.
- Timestamps are ISO 8601 UTC. Summary dates are inclusive calendar dates; use `timeZone` for a business-local day.

## Frontend screen mapping

| Frontend screen | API |
| --- | --- |
| Login / registration | `POST /auth/login`, `POST /auth/register` |
| Session / logout / password | `GET /auth/me`, `POST /auth/logout`, `POST /auth/password` |
| User management (Admin) | `GET /users`, `GET /users/roles`, `POST /users`, `PATCH /users/{userId}` |
| Dashboard | `GET /dashboard` |
| Component tracking | `POST /component-tracking`, `GET /activity/tracked-products` |
| Receive stock | `GET /stock-points?type=RECEIVE`, `POST /receipts` (product unit + component barcode), `GET /activity/received-products` |
| Deliver stock | `GET /stock-points?type=DELIVERY`, `POST /deliveries`, `GET /activity/delivered-products` |
| Products / components | `GET` and `POST /products` or `/components`; `PUT /products/{productId}/required-components` |
| Receive / delivery points | `GET` and `POST /stock-points` with the corresponding type |
| Reversals | `POST /transactions/{transactionId}/reversals` |
| Stock details | `GET /reports/stock-details` |
| Summary report | `GET /reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD` |
| Barcode history | `GET /reports/barcode-history?barcode=...` |
| Audit logs | `GET /audit-logs` |

## Data model

The workflow is component tracking → receiving → delivery. Admins configure each product's required component codes. Receive Users scan both the product unit barcode and each associated component barcode; the unit becomes `IN_STOCK` only after every required component has been received. Delivery rechecks those receipts and reports missing component names and codes. Delivery accepts only the product unit barcode (`PRD-00000001`), never a component barcode. Component tracking registers a product unit as `PENDING_RECEIPT`; delivery changes it to `DELIVERED`. Component barcodes use `PRD-CMP-00000001`. Product codes and component codes are inferred from the barcode prefixes.

## Run locally

1. Copy `.env.example` to `.env` and set `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` (or set `DATABASE_URL`).
2. Create the PostgreSQL database named in `DB_NAME` or `DATABASE_URL`.
3. Run `npm run db:setup` to initialize the isolated schema. Set bootstrap Admin variables only when no active Admin is imported.
4. Run `npm run dev` in the backend folder.
5. Copy the frontend's `.env.local.example` to `.env.local`, then run `npm run dev` in the frontend folder.
