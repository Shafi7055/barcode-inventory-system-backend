# Barcode Inventory System — Backend

A local REST API for tracking products, components, inventory receipts and deliveries, stock points, reports, users, and audit activity.

The backend is built with Node.js and Express, uses PostgreSQL for persistence, and exposes a versioned API at `/api/v1`. It is designed to run alongside a separate Next.js frontend through a same-origin API proxy.

> **Local use only:** the server binds to `127.0.0.1` and refuses to start when `NODE_ENV=production`. Do not expose this API directly to a network or use it with production data.

## Features

- Cookie-based sign-in and 12-hour signed sessions
- Server-enforced role and permission checks
- Product and component catalog management
- Receive and delivery stock points
- Barcode-based stock receiving and delivery
- Component-to-product instance tracking
- Transactional inventory movements and reversible receipts/deliveries
- Idempotency support for concurrent write protection
- Dashboard, stock, summary, barcode history, and audit reports
- Admin-managed users, roles, password changes, and account status
- OpenAPI specification in [`openapi.json`](./openapi.json)

## Technology Stack

| Technology | Purpose |
| --- | --- |
| Node.js 20+ | JavaScript runtime |
| Express 5 | HTTP API framework |
| PostgreSQL | Persistent inventory and audit data |
| `pg` | PostgreSQL connection pool |
| `bcryptjs` | Password hashing |
| `dotenv` | Environment configuration |
| CORS | Local frontend integration |
| Nodemon | Development reloads |

The database schema is isolated in the PostgreSQL `barcode_inventory` schema, keeping it separate from the database's `public` schema.

## Project Structure

```text
barcode-inventory-system-backend/
├── index.js                 # Process entry point
├── db.js                    # PostgreSQL pool and database configuration
├── setup-db.js              # Database bootstrap and initial Admin creation
├── schema.sql               # Roles, catalog, inventory, history, and audit tables
├── openapi.json             # OpenAPI 3 API specification
├── API-DESIGN.md            # API conventions and frontend integration guide
└── src/
    ├── app.js               # Express middleware and route registration
    ├── auth/
    │   └── roles.js         # Fixed roles and permission mapping
    ├── routes/
    │   ├── auth.routes.js   # Sign-in, registration, session, and password routes
    │   ├── users.routes.js  # Admin user-management routes
    │   └── api.routes.js    # Dashboard, catalog, inventory, and report routes
    ├── controllers/         # Request validation and HTTP response handling
    ├── services/
    │   └── transaction.service.js  # Transactions and idempotency helpers
    ├── middleware/
    │   ├── auth.js          # Session verification and permission checks
    │   ├── error-handler.js # Consistent API error responses
    │   └── request-id.js    # Request tracking IDs
    ├── errors/
    │   └── api-error.js     # Structured application errors
    └── utils/               # Pagination and input validation helpers
```

## Roles and Permissions

| Role | Typical access |
| --- | --- |
| Admin | Dashboard, inventory operations, catalog management, reports, audit logs, user management, and reversals |
| Component Tracker | Attach components to product instances |
| Receive User | Receive products at receive stock points |
| Delivery User | Deliver products from delivery stock points |
| Report Viewer | View reports and receive a read-only account |

The frontend hides or shows navigation for usability, but every protected API route is enforced again by server-side middleware.

## Prerequisites

Before starting, install:

- [Node.js](https://nodejs.org/) 20 or newer
- [PostgreSQL](https://www.postgresql.org/) 14 or newer
- npm, included with Node.js
- A Next.js frontend when testing through the browser

## Environment Configuration

Create a `.env` file in the backend directory.

You can configure PostgreSQL either with individual variables or a database connection URL:

```dotenv
# Individual PostgreSQL connection settings
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=your_database_name
DB_USER=your_database_user
DB_PASSWORD=your_database_password

# Alternative to the variables above:
# DATABASE_URL=postgresql://user:password@127.0.0.1:5432/your_database_name

# Server and frontend settings
PORT=4000
FRONTEND_ORIGIN=http://localhost:3000

# Required to create the first Admin account during database setup
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=replace-with-a-private-password

# Optional; a secure random value is strongly recommended outside development
SESSION_SECRET=replace-with-a-long-random-secret
```

Password requirements:

- Bootstrap Admin password: at least 12 characters
- Regular user and registration passwords: at least 12 characters
- Maximum password length: 128 characters

## Local Setup

### 1. Create a PostgreSQL database

Create an empty PostgreSQL database, then add its connection details to `.env`.

### 2. Install dependencies

```bash
npm install
```

### 3. Initialize the database

```bash
npm run db:setup
```

This command:

- creates the `barcode_inventory` schema if it does not exist;
- creates or updates the roles, users, products, components, stock points, units, inventory history, and audit tables;
- preserves the database's `public` schema;
- creates the initial Admin account only when no active Admin exists and valid bootstrap credentials are supplied.

No default login credentials are created. If there is no active Admin, set `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_PASSWORD` before running the setup command.

### 4. Start the development server

```bash
npm run dev
```

The backend starts at:

```text
http://127.0.0.1:4000
```

For a direct production-style Node process:

```bash
npm start
```

This API still refuses to start when `NODE_ENV=production`.

### 5. Verify the API

```bash
curl http://127.0.0.1:4000/health
```

Expected response:

```json
{
  "status": "ok"
}
```

## API Overview

All application endpoints are mounted below `/api/v1`. Authentication routes can set or clear the `inventory_session` HttpOnly cookie.

| Area | Example endpoints |
| --- | --- |
| Health | `GET /health` |
| Authentication | `POST /api/v1/auth/login`, `GET /api/v1/auth/me`, `POST /api/v1/auth/logout` |
| Password | `POST /api/v1/auth/password` |
| Registration | `POST /api/v1/auth/register` |
| Users | `GET /api/v1/users`, `POST /api/v1/users`, `PATCH /api/v1/users/:userId` |
| Dashboard | `GET /api/v1/dashboard` |
| Catalog | `/api/v1/products`, `/api/v1/components`, `/api/v1/stock-points` |
| Inventory | `POST /api/v1/component-tracking`, `/api/v1/receipts`, `/api/v1/deliveries` |
| Reversals | `POST /api/v1/transactions/:transactionId/reversals` |
| Reports | `/api/v1/reports/stock-details`, `/api/v1/reports/summary`, `/api/v1/reports/barcode-history` |
| Audit | `GET /api/v1/audit-logs` |

The complete request and response contract is documented in [`openapi.json`](./openapi.json). Integration conventions and frontend route mappings are described in [`API-DESIGN.md`](./API-DESIGN.md).

## Request and Response Conventions

### Request format

Send JSON request bodies with:

```http
Content-Type: application/json
```

### Pagination

List endpoints return:

```json
{
  "data": [],
  "meta": {
    "page": 1,
    "pageSize": 25,
    "totalItems": 0,
    "totalPages": 0
  }
}
```

The default page size is 25. The maximum supported page size is 100.

### Error format

Errors use a consistent structure:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "The requested resource was not found.",
    "requestId": "unique-request-id",
    "details": []
  }
}
```

Validation errors use the `422` status and may include field-level details.

### Inventory writes

Receipt, delivery, component-tracking, and reversal operations use PostgreSQL transactions. A write can include an `Idempotency-Key` header:

```http
Idempotency-Key: unique-request-key-123
```

The key must contain at least 16 characters and at most 128 characters. Reusing it for the same authenticated user serializes the operation and prevents unintended duplicate writes.

## Frontend Integration

This backend is expected to be reached through a same-origin Next.js proxy rather than called directly from the browser.

Recommended local setup:

```text
Frontend: http://localhost:3000
Backend:  http://127.0.0.1:4000
```

Set `FRONTEND_ORIGIN` to the frontend origin for CORS and configure the frontend API proxy to use `http://127.0.0.1:4000` as `API_SERVER_ORIGIN`.

## Development Notes

- `index.js` loads `src/app.js` and starts the HTTP server on port 4000 by default.
- `src/app.js` configures CORS, JSON parsing, health checking, authentication routes, protected routes, and error handling.
- `src/routes/` maps URLs to controllers and permission middleware.
- `src/services/transaction.service.js` owns database transactions, idempotency locking, and inventory validation.
- `schema.sql` uses `SERIAL` primary keys and JSONB fields for audit data.
- Inventory writes modify `units` and append entries to `inventory_history`; reversals create a new reversal entry instead of rewriting existing history.
- Session cookies expire after 12 hours. Changing a password invalidates existing sessions.

## Related Documentation

- [API design and integration conventions](./API-DESIGN.md)
- [OpenAPI specification](./openapi.json)
