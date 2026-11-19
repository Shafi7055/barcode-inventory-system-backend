require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { randomUUID, createHash } = require("node:crypto");
const { Pool } = require("pg");

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT = Number(process.env.PORT) || 4000;

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

app.use((req, res, next) => {
  req.requestId = randomUUID();
  next();
});
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || "http://localhost:3000",
  credentials: false,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Idempotency-Key"],
}));
app.use(express.json({ limit: "1mb" }));
app.use("/api/v1", async (req, _res, next) => {
  try {
    const result = await pool.query(
      "SELECT user_id, name FROM users WHERE is_system = TRUE",
    );
    if (!result.rowCount) {
      throw new ApiError(503, "NOT_READY", "Run npm run db:setup to prepare the local API.");
    }
    req.actor = { id: result.rows[0].user_id, name: result.rows[0].name };
    next();
  } catch (error) {
    next(error);
  }
});

function integer(value, field, { required = false } = {}) {
  if ((value === undefined || value === null || value === "") && !required) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ApiError(422, "VALIDATION_ERROR", `${field} must be a positive integer.`, [{ field, message: "Must be a positive integer." }]);
  }
  return parsed;
}

function requiredString(value, field, maxLength = 1000) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new ApiError(422, "VALIDATION_ERROR", `${field} is required and must be at most ${maxLength} characters.`, [{ field, message: "Enter a valid value." }]);
  }
  return value.trim();
}

function validatePage(query) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const pageSize = query.pageSize === undefined ? 25 : Number(query.pageSize);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid pagination values.", [
      { field: "page", message: "Page must be a positive integer." },
      { field: "pageSize", message: "Page size must be from 1 to 100." },
    ]);
  }
  return { page, pageSize, offset: (page - 1) * pageSize };
}

async function pagedQuery(req, res, countSql, rowsSql, values = []) {
  const { page, pageSize, offset } = validatePage(req.query);
  const count = await pool.query(countSql, values);
  const rows = await pool.query(rowsSql, [...values, pageSize, offset]);
  const totalItems = Number(count.rows[0].total);
  res.json({
    data: rows.rows,
    meta: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) },
  });
}

function sendApiError(error, req, res, _next) {
  if (res.headersSent) return;
  const status = error instanceof ApiError ? error.status : error.code === "23505" ? 409 : 500;
  if (status === 500) console.error(`[${req.requestId}]`, error);
  res.status(status).json({
    error: {
      code: error instanceof ApiError ? error.code : error.code === "23505" ? "CONFLICT" : "INTERNAL_ERROR",
      message: error instanceof ApiError
        ? error.message
        : error.code === "23505"
          ? "A record with the same unique value already exists."
          : "An unexpected server error occurred.",
      requestId: req.requestId,
      ...(error instanceof ApiError && error.details ? { details: error.details } : {}),
    },
  });
}

async function writeAudit(client, userId, action, tableName, newValue, oldValue = null) {
  await client.query(
    `INSERT INTO audit_logs (user_id, action, table_name, old_value, new_value)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, action, tableName, oldValue, newValue],
  );
}

async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function idempotentWrite(req, res, status, work) {
  const key = requiredString(req.get("Idempotency-Key"), "Idempotency-Key", 128);
  if (key.length < 16) {
    throw new ApiError(422, "VALIDATION_ERROR", "Idempotency-Key must contain at least 16 characters.");
  }
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ method: req.method, path: req.path, body: req.body }))
    .digest("hex");
  const result = await inTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1::integer, hashtext($2))", [req.actor.id, key]);
    const saved = await client.query(
      `SELECT request_hash, response_status, response_body
       FROM idempotency_records WHERE user_id = $1 AND idempotency_key = $2`,
      [req.actor.id, key],
    );
    if (saved.rowCount) {
      if (saved.rows[0].request_hash !== requestHash) {
        throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for a different request.");
      }
      return { status: saved.rows[0].response_status, body: saved.rows[0].response_body };
    }
    const body = await work(client);
    await client.query(
      `INSERT INTO idempotency_records (user_id, idempotency_key, request_hash, response_status, response_body)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.actor.id, key, requestHash, status, body],
    );
    return { status, body };
  });
  res.status(result.status).json(result.body);
}

async function getMovement(client, transactionId) {
  const result = await client.query(
    `SELECT t.transaction_id AS "transactionId", pi.barcode,
            t.event_type AS "eventType", sp.point_name AS point, t.reason,
            t.original_transaction_id AS "originalTransactionId",
            t.transaction_time AS "transactionTime", u.name AS "performedBy"
     FROM inventory_transactions t
     JOIN product_instances pi ON pi.unit_id = t.unit_id
     JOIN users u ON u.user_id = t.user_id
     LEFT JOIN stock_points sp ON sp.point_id = t.point_id
     WHERE t.transaction_id = $1`,
    [transactionId],
  );
  return result.rows[0];
}

async function validateStockPoint(client, pointId, type) {
  const result = await client.query(
    "SELECT point_id FROM stock_points WHERE point_id = $1 AND point_type = $2 AND is_active = TRUE",
    [pointId, type],
  );
  if (!result.rowCount) throw new ApiError(404, "NOT_FOUND", `Active ${type.toLowerCase()} point not found.`);
}

app.get("/health", async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ status: "ok" });
});

app.get("/api/v1/dashboard", async (req, res) => {
  const [stock, received, delivered, recent] = await Promise.all([
    pool.query("SELECT COUNT(*)::integer AS total FROM product_instances WHERE status = 'IN_STOCK'"),
    pool.query(
      "SELECT COUNT(*)::integer AS total FROM inventory_transactions WHERE event_type = 'RECEIVED' AND transaction_time >= CURRENT_DATE",
    ),
    pool.query(
      "SELECT COUNT(*)::integer AS total FROM inventory_transactions WHERE event_type = 'DELIVERED' AND transaction_time >= CURRENT_DATE",
    ),
    pool.query(
      `SELECT t.transaction_id AS "transactionId", pi.barcode,
              t.event_type AS "eventType", sp.point_name AS point, t.reason,
              t.original_transaction_id AS "originalTransactionId",
              t.transaction_time AS "transactionTime", u.name AS "performedBy"
       FROM inventory_transactions t
       JOIN product_instances pi ON pi.unit_id = t.unit_id
       JOIN users u ON u.user_id = t.user_id
       LEFT JOIN stock_points sp ON sp.point_id = t.point_id
       ORDER BY t.transaction_time DESC, t.transaction_id DESC LIMIT 10`,
    ),
  ]);
  res.json({
    data: {
      itemsInStock: stock.rows[0].total,
      receivedToday: received.rows[0].total,
      deliveredToday: delivered.rows[0].total,
      recentMovements: recent.rows,
    },
  });
});

app.get("/api/v1/products", async (req, res) => {
  await pagedQuery(
    req, res,
    "SELECT COUNT(*)::integer AS total FROM products WHERE is_active = TRUE",
    `SELECT product_id AS id, product_name AS name, product_code AS code,
            description, is_active AS "isActive", created_at AS "createdAt"
     FROM products WHERE is_active = TRUE ORDER BY product_name
     LIMIT $1 OFFSET $2`,
  );
});

app.post("/api/v1/products", async (req, res) => {
  const name = requiredString(req.body?.name, "name", 200);
  const code = requiredString(req.body?.code, "code", 100);
  const description = typeof req.body.description === "string" ? req.body.description.trim() : null;
  const product = await inTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO products (product_name, product_code, description)
       VALUES ($1, $2, $3)
       RETURNING product_id AS id, product_name AS name, product_code AS code,
                 description, is_active AS "isActive", created_at AS "createdAt"`,
      [name, code, description],
    );
    await writeAudit(client, req.actor.id, "CREATE", "products", result.rows[0]);
    return result.rows[0];
  });
  res.status(201).json({ data: product });
});

app.get("/api/v1/components", async (req, res) => {
  await pagedQuery(
    req, res,
    "SELECT COUNT(*)::integer AS total FROM components WHERE is_active = TRUE",
    `SELECT component_id AS id, component_name AS name, component_code AS code,
            component_barcode AS barcode, is_active AS "isActive", created_at AS "createdAt"
     FROM components WHERE is_active = TRUE ORDER BY component_name
     LIMIT $1 OFFSET $2`,
  );
});

app.post("/api/v1/components", async (req, res) => {
  const name = requiredString(req.body?.name, "name", 200);
  const code = requiredString(req.body?.code, "code", 100);
  const barcode = requiredString(req.body?.barcode, "barcode", 200);
  const component = await inTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO components (component_name, component_code, component_barcode)
       VALUES ($1, $2, $3)
       RETURNING component_id AS id, component_name AS name, component_code AS code,
                 component_barcode AS barcode, is_active AS "isActive", created_at AS "createdAt"`,
      [name, code, barcode],
    );
    await writeAudit(client, req.actor.id, "CREATE", "components", result.rows[0]);
    return result.rows[0];
  });
  res.status(201).json({ data: component });
});

app.get("/api/v1/stock-points", async (req, res) => {
  const type = req.query.type;
  if (!["RECEIVE", "DELIVERY"].includes(type)) {
    throw new ApiError(422, "VALIDATION_ERROR", "type must be RECEIVE or DELIVERY.");
  }
  const result = await pool.query(
    `SELECT point_id AS id, point_name AS name, point_type AS type, is_active AS "isActive"
     FROM stock_points WHERE point_type = $1 AND is_active = TRUE ORDER BY point_name`,
    [type],
  );
  res.json({ data: result.rows });
});

app.post("/api/v1/stock-points", async (req, res) => {
  const name = requiredString(req.body?.name, "name", 200);
  const type = req.body?.type;
  if (!["RECEIVE", "DELIVERY"].includes(type)) {
    throw new ApiError(422, "VALIDATION_ERROR", "type must be RECEIVE or DELIVERY.");
  }
  const point = await inTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO stock_points (point_name, point_type)
       VALUES ($1, $2)
       RETURNING point_id AS id, point_name AS name, point_type AS type, is_active AS "isActive"`,
      [name, type],
    );
    await writeAudit(client, req.actor.id, "CREATE", "stock_points", result.rows[0]);
    return result.rows[0];
  });
  res.status(201).json({ data: point });
});

app.post("/api/v1/component-tracking", async (req, res) => {
  const productBarcode = requiredString(req.body?.productBarcode, "productBarcode", 200);
  const componentBarcode = requiredString(req.body?.componentBarcode, "componentBarcode", 200);
  const result = await inTransaction(async (client) => {
    const unit = await client.query(
      "SELECT unit_id FROM product_instances WHERE barcode = $1 FOR UPDATE",
      [productBarcode],
    );
    const component = await client.query(
      "SELECT component_id FROM components WHERE component_barcode = $1 AND is_active = TRUE",
      [componentBarcode],
    );
    if (!unit.rowCount || !component.rowCount) throw new ApiError(404, "NOT_FOUND", "Product or component barcode was not found.");
    const inserted = await client.query(
      `INSERT INTO product_instance_components (unit_id, component_id)
       VALUES ($1, $2) ON CONFLICT (unit_id, component_id) DO NOTHING
       RETURNING id, unit_id AS "unitId", component_id AS "componentId", created_at AS "createdAt"`,
      [unit.rows[0].unit_id, component.rows[0].component_id],
    );
    if (!inserted.rowCount) throw new ApiError(409, "CONFLICT", "This component is already attached to the product.");
    await client.query(
      `INSERT INTO inventory_transactions (unit_id, event_type, user_id)
       VALUES ($1, 'COMPONENT', $2)`,
      [unit.rows[0].unit_id, req.actor.id],
    );
    return {
      unitId: inserted.rows[0].unitId,
      productBarcode,
      componentBarcode,
      createdAt: inserted.rows[0].createdAt,
    };
  });
  res.status(201).json({ data: result });
});

app.post("/api/v1/receipts", async (req, res) => {
  const barcode = requiredString(req.body?.barcode, "barcode", 200);
  const pointId = integer(req.body?.pointId, "pointId", { required: true });
  const productId = integer(req.body?.productId, "productId", { required: true });
  await idempotentWrite(req, res, 201, async (client) => {
    await validateStockPoint(client, pointId, "RECEIVE");
    const product = await client.query("SELECT product_id FROM products WHERE product_id = $1 AND is_active = TRUE", [productId]);
    if (!product.rowCount) throw new ApiError(404, "NOT_FOUND", "Active product not found.");
    const found = await client.query("SELECT * FROM product_instances WHERE barcode = $1 FOR UPDATE", [barcode]);
    let unitId;
    if (found.rowCount) {
      if (found.rows[0].product_id !== productId) throw new ApiError(409, "CONFLICT", "Barcode is already registered to another product.");
      if (found.rows[0].status === "IN_STOCK") throw new ApiError(409, "CONFLICT", "This item is already in stock.");
      unitId = found.rows[0].unit_id;
      await client.query(
        "UPDATE product_instances SET status = 'IN_STOCK', receive_point_id = $2 WHERE unit_id = $1",
        [unitId, pointId],
      );
    } else {
      const created = await client.query(
        `INSERT INTO product_instances (product_id, barcode, status, receive_point_id)
         VALUES ($1, $2, 'IN_STOCK', $3) RETURNING unit_id`,
        [productId, barcode, pointId],
      );
      unitId = created.rows[0].unit_id;
    }
    const movement = await client.query(
      `INSERT INTO inventory_transactions (unit_id, event_type, point_id, user_id)
       VALUES ($1, 'RECEIVED', $2, $3) RETURNING transaction_id`,
      [unitId, pointId, req.actor.id],
    );
    await client.query(
      `INSERT INTO receipts (transaction_id, barcode, received_by) VALUES ($1, $2, $3)`,
      [movement.rows[0].transaction_id, barcode, req.actor.id],
    );
    return { data: await getMovement(client, movement.rows[0].transaction_id) };
  });
});

app.post("/api/v1/deliveries", async (req, res) => {
  const barcode = requiredString(req.body?.barcode, "barcode", 200);
  const pointId = integer(req.body?.pointId, "pointId", { required: true });
  await idempotentWrite(req, res, 201, async (client) => {
    await validateStockPoint(client, pointId, "DELIVERY");
    const unit = await client.query("SELECT * FROM product_instances WHERE barcode = $1 FOR UPDATE", [barcode]);
    if (!unit.rowCount) throw new ApiError(404, "NOT_FOUND", "Product barcode was not found.");
    if (unit.rows[0].status !== "IN_STOCK") throw new ApiError(409, "CONFLICT", "Only items in stock can be delivered.");
    await client.query("UPDATE product_instances SET status = 'DELIVERED' WHERE unit_id = $1", [unit.rows[0].unit_id]);
    const movement = await client.query(
      `INSERT INTO inventory_transactions (unit_id, event_type, point_id, user_id)
       VALUES ($1, 'DELIVERED', $2, $3) RETURNING transaction_id`,
      [unit.rows[0].unit_id, pointId, req.actor.id],
    );
    await client.query(
      `INSERT INTO deliveries (transaction_id, barcode, delivered_by) VALUES ($1, $2, $3)`,
      [movement.rows[0].transaction_id, barcode, req.actor.id],
    );
    return { data: await getMovement(client, movement.rows[0].transaction_id) };
  });
});

app.post("/api/v1/transactions/:transactionId/reversals", async (req, res) => {
  const transactionId = integer(req.params.transactionId, "transactionId", { required: true });
  const reason = requiredString(req.body?.reason, "reason", 1000);
  await idempotentWrite(req, res, 201, async (client) => {
    const original = await client.query(
      "SELECT * FROM inventory_transactions WHERE transaction_id = $1 FOR UPDATE",
      [transactionId],
    );
    if (!original.rowCount) throw new ApiError(404, "NOT_FOUND", "Transaction not found.");
    const transaction = original.rows[0];
    if (!["RECEIVED", "DELIVERED"].includes(transaction.event_type)) {
      throw new ApiError(409, "CONFLICT", "Only receipt or delivery transactions can be reversed.");
    }
    const instance = await client.query(
      "SELECT status FROM product_instances WHERE unit_id = $1 FOR UPDATE",
      [transaction.unit_id],
    );
    if (!instance.rowCount) throw new ApiError(404, "NOT_FOUND", "Inventory item not found.");
    const later = await client.query(
      `SELECT transaction_id FROM inventory_transactions
       WHERE unit_id = $1 AND transaction_id > $2
         AND event_type IN ('RECEIVED', 'DELIVERED', 'REVERSED')
       LIMIT 1`,
      [transaction.unit_id, transactionId],
    );
    if (later.rowCount) throw new ApiError(409, "CONFLICT", "Reverse later inventory activity first.");
    const alreadyReversed = await client.query(
      "SELECT transaction_id FROM inventory_transactions WHERE original_transaction_id = $1",
      [transactionId],
    );
    if (alreadyReversed.rowCount) throw new ApiError(409, "CONFLICT", "This transaction has already been reversed.");
    const nextStatus = transaction.event_type === "DELIVERED" ? "IN_STOCK" : "DELIVERED";
    const expectedCurrentStatus = transaction.event_type === "DELIVERED" ? "DELIVERED" : "IN_STOCK";
    if (instance.rows[0].status !== expectedCurrentStatus) {
      throw new ApiError(409, "CONFLICT", "The item's current status no longer matches this transaction.");
    }
    await client.query("UPDATE product_instances SET status = $2 WHERE unit_id = $1", [transaction.unit_id, nextStatus]);
    const reversal = await client.query(
      `INSERT INTO inventory_transactions
         (unit_id, event_type, point_id, user_id, reason, original_transaction_id)
       VALUES ($1, 'REVERSED', $2, $3, $4, $5) RETURNING transaction_id`,
      [transaction.unit_id, transaction.point_id, req.actor.id, reason, transactionId],
    );
    return { data: await getMovement(client, reversal.rows[0].transaction_id) };
  });
});

app.get("/api/v1/reports/stock-details", async (req, res) => {
  const { page, pageSize, offset } = validatePage(req.query);
  const status = req.query.status;
  if (status && !["IN_STOCK", "DELIVERED"].includes(status)) throw new ApiError(422, "VALIDATION_ERROR", "Invalid stock status.");
  const search = typeof req.query.search === "string" ? `%${req.query.search.trim()}%` : null;
  const values = [status || null, search];
  const count = await pool.query(
    `SELECT COUNT(*)::integer AS total FROM product_instances pi
     JOIN products p ON p.product_id = pi.product_id
     WHERE ($1::text IS NULL OR pi.status = $1)
       AND ($2::text IS NULL OR pi.barcode ILIKE $2 OR p.product_name ILIKE $2)`,
    values,
  );
  const rows = await pool.query(
    `SELECT pi.unit_id AS "unitId", pi.barcode, pi.product_id AS "productId",
            p.product_name AS "productName", pi.status, sp.point_name AS "receivePoint",
            pi.created_at AS "createdAt"
     FROM product_instances pi
     JOIN products p ON p.product_id = pi.product_id
     LEFT JOIN stock_points sp ON sp.point_id = pi.receive_point_id
     WHERE ($1::text IS NULL OR pi.status = $1)
       AND ($2::text IS NULL OR pi.barcode ILIKE $2 OR p.product_name ILIKE $2)
     ORDER BY pi.created_at DESC LIMIT $3 OFFSET $4`,
    [...values, pageSize, offset],
  );
  const totalItems = Number(count.rows[0].total);
  res.json({ data: rows.rows, meta: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) } });
});

app.get("/api/v1/reports/summary", async (req, res) => {
  const { from, to } = req.query;
  const timeZone = typeof req.query.timeZone === "string" ? req.query.timeZone : "UTC";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || "") || !/^\d{4}-\d{2}-\d{2}$/.test(to || "") || from > to) {
    throw new ApiError(422, "VALIDATION_ERROR", "Provide a valid inclusive from/to date range.");
  }
  const result = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE event_type = 'RECEIVED')::integer AS received,
            COUNT(*) FILTER (WHERE event_type = 'DELIVERED')::integer AS delivered,
            COUNT(*) FILTER (WHERE event_type = 'REVERSED')::integer AS reversed
     FROM inventory_transactions
     WHERE transaction_time >= (($1::date)::timestamp AT TIME ZONE $3)
       AND transaction_time < ((($2::date + 1)::timestamp) AT TIME ZONE $3)`,
    [from, to, timeZone],
  );
  res.json({ data: { from, to, ...result.rows[0] } });
});

app.get("/api/v1/reports/barcode-history", async (req, res) => {
  const barcode = requiredString(req.query.barcode, "barcode", 200);
  const instance = await pool.query("SELECT unit_id FROM product_instances WHERE barcode = $1", [barcode]);
  if (!instance.rowCount) throw new ApiError(404, "NOT_FOUND", "Barcode was not found.");
  const result = await pool.query(
    `SELECT t.transaction_id AS "transactionId", pi.barcode,
            t.event_type AS "eventType", sp.point_name AS point, t.reason,
            t.original_transaction_id AS "originalTransactionId",
            t.transaction_time AS "transactionTime", u.name AS "performedBy"
     FROM inventory_transactions t
     JOIN product_instances pi ON pi.unit_id = t.unit_id
     JOIN users u ON u.user_id = t.user_id
     LEFT JOIN stock_points sp ON sp.point_id = t.point_id
     WHERE t.unit_id = $1 ORDER BY t.transaction_time, t.transaction_id`,
    [instance.rows[0].unit_id],
  );
  res.json({ data: result.rows });
});

app.get("/api/v1/audit-logs", async (req, res) => {
  const from = req.query.from || null;
  const to = req.query.to || null;
  await pagedQuery(
    req, res,
    `SELECT COUNT(*)::integer AS total FROM audit_logs
     WHERE ($1::timestamptz IS NULL OR created_at >= $1)
       AND ($2::timestamptz IS NULL OR created_at <= $2)`,
    `SELECT a.log_id AS id, a.user_id AS "userId", u.name AS "userName",
            a.action, a.table_name AS "tableName", a.old_value AS "oldValue",
            a.new_value AS "newValue", a.created_at AS "createdAt"
     FROM audit_logs a JOIN users u ON u.user_id = a.user_id
     WHERE ($1::timestamptz IS NULL OR a.created_at >= $1)
       AND ($2::timestamptz IS NULL OR a.created_at <= $2)
     ORDER BY a.created_at DESC LIMIT $3 OFFSET $4`,
    [from, to],
  );
});

app.use("/api", (_req, _res, next) => next(new ApiError(404, "NOT_FOUND", "API route not found.")));
app.use(sendApiError);

if (require.main === module) {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL must be set. Copy .env.example to .env and configure PostgreSQL.");
    process.exitCode = 1;
  } else if (process.env.NODE_ENV === "production") {
    console.error("The no-auth API is local-development only and cannot run in production.");
    process.exitCode = 1;
  } else {
    app.listen(PORT, "127.0.0.1", () => console.log(`Local Barcode Inventory API listening on 127.0.0.1:${PORT}.`));
  }
}

module.exports = { app, pool };