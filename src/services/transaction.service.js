import { createHash } from "node:crypto";
import { pool } from "../../db.js";
import { ApiError } from "../errors/api-error.js";
import { requiredString } from "../utils/validation.js";

async function writeAudit(client, userId, action, tableName, newValue) {
  await client.query(
    `INSERT INTO audit_logs (user_id, action, table_name, new_value)
     VALUES ($1, $2, $3, $4)`,
    [userId, action, tableName, newValue],
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

async function idempotentWrite(req, status, work) {
  const key = requiredString(req.get("Idempotency-Key"), "Idempotency-Key", 128);
  if (key.length < 16) {
    throw new ApiError(422, "VALIDATION_ERROR", "Idempotency-Key must contain at least 16 characters.");
  }
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ method: req.method, path: req.path, body: req.body }))
    .digest("hex");
  return inTransaction(async (client) => {
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

export { getMovement, idempotentWrite, inTransaction, validateStockPoint, writeAudit };
