import { pool } from "../../db.js";
import { ApiError } from "../errors/api-error.js";
import { requiredString } from "../utils/validation.js";

const MOVEMENT_SELECT = `SELECT t.transaction_id AS "transactionId", pi.barcode,
                               t.event_type AS "eventType", c.component_name AS component,
                               sp.point_name AS point, t.reason,
                               t.original_transaction_id AS "originalTransactionId",
                               t.transaction_time AS "transactionTime", u.name AS "performedBy"
                        FROM inventory_history t
                        JOIN units pi ON pi.unit_id = t.unit_id
                        JOIN users u ON u.user_id = t.user_id
                        LEFT JOIN points sp ON sp.point_id = t.point_id
                        LEFT JOIN components c ON c.component_id = t.component_id`;

async function writeAudit(client, userId, action, tableName, newValue, oldValue = null) {
  await client.query(
    `INSERT INTO audit_logs (user_id, action, table_name, new_value, old_value)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, action, tableName, newValue, oldValue],
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
  const key = req.get("Idempotency-Key");
  if (key !== undefined) {
    const validatedKey = requiredString(key, "Idempotency-Key", 128);
    if (validatedKey.length < 16) {
      throw new ApiError(422, "VALIDATION_ERROR", "Idempotency-Key must contain at least 16 characters.");
    }
  }
  return inTransaction(async (client) => {
    if (key) {
      await client.query("SELECT pg_advisory_xact_lock($1::integer, hashtext($2))", [req.actor.id, key]);
    }
    const body = await work(client);
    return { status, body };
  });
}

async function getMovement(client, transactionId) {
  const result = await client.query(
    `${MOVEMENT_SELECT} WHERE t.transaction_id = $1`,
    [transactionId],
  );
  return result.rows[0];
}

async function validateStockPoint(client, pointId, type) {
  const result = await client.query(
    "SELECT point_id FROM points WHERE point_id = $1 AND point_type = $2 AND is_active = TRUE",
    [pointId, type],
  );
  if (!result.rowCount) throw new ApiError(404, "NOT_FOUND", `Active ${type.toLowerCase()} point not found.`);
}

export { getMovement, idempotentWrite, inTransaction, MOVEMENT_SELECT, validateStockPoint, writeAudit };
