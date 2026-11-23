import { pool } from "../../db.js";
import { ApiError } from "../errors/api-error.js";
import { pagedQuery } from "../utils/paged-query.js";
import { requiredString, validatePage } from "../utils/validation.js";

async function stockDetails(req, res) {
  const { page, pageSize, offset } = validatePage(req.query);
  const status = req.query.status;
  if (status && !["IN_STOCK", "DELIVERED"].includes(status)) throw new ApiError(422, "VALIDATION_ERROR", "Invalid stock status.");
  const search = typeof req.query.search === "string" ? `%${req.query.search.trim()}%` : null;
  const values = [status || null, search];
  const count = await pool.query(
    `SELECT COUNT(*)::integer AS total FROM units pi
     JOIN products p ON p.product_id = pi.product_id
     WHERE pi.status IN ('IN_STOCK', 'DELIVERED')
       AND ($1::text IS NULL OR pi.status = $1)
       AND ($2::text IS NULL OR pi.barcode ILIKE $2 OR p.product_name ILIKE $2)`,
    values,
  );
  const rows = await pool.query(
    `SELECT pi.unit_id AS "unitId", pi.barcode, pi.product_id AS "productId",
            p.product_name AS "productName", pi.status, sp.point_name AS "receivePoint",
            pi.created_at AS "createdAt"
     FROM units pi
     JOIN products p ON p.product_id = pi.product_id
     LEFT JOIN points sp ON sp.point_id = pi.receive_point_id
     WHERE pi.status IN ('IN_STOCK', 'DELIVERED')
       AND ($1::text IS NULL OR pi.status = $1)
       AND ($2::text IS NULL OR pi.barcode ILIKE $2 OR p.product_name ILIKE $2)
     ORDER BY pi.created_at DESC LIMIT $3 OFFSET $4`,
    [...values, pageSize, offset],
  );
  const totalItems = Number(count.rows[0].total);
  res.json({ data: rows.rows, meta: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) } });
}

async function summary(req, res) {
  const { from, to } = req.query;
  const timeZone = typeof req.query.timeZone === "string" ? req.query.timeZone : "UTC";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || "") || !/^\d{4}-\d{2}-\d{2}$/.test(to || "") || from > to) {
    throw new ApiError(422, "VALIDATION_ERROR", "Provide a valid inclusive from/to date range.");
  }
  const result = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE event_type = 'RECEIVED')::integer AS received,
            COUNT(*) FILTER (WHERE event_type = 'DELIVERED')::integer AS delivered,
            COUNT(*) FILTER (WHERE event_type = 'REVERSED')::integer AS reversed
     FROM inventory_history
     WHERE transaction_time >= (($1::date)::timestamp AT TIME ZONE $3)
       AND transaction_time < ((($2::date + 1)::timestamp) AT TIME ZONE $3)`,
    [from, to, timeZone],
  );
  res.json({ data: { from, to, ...result.rows[0] } });
}

async function barcodeHistory(req, res) {
  const barcode = requiredString(req.query.barcode, "barcode", 200);
  const instance = await pool.query("SELECT unit_id FROM units WHERE barcode = $1", [barcode]);
  if (!instance.rowCount) throw new ApiError(404, "NOT_FOUND", "Barcode was not found.");
  const result = await pool.query(
    `SELECT t.transaction_id AS "transactionId", pi.barcode,
            t.event_type AS "eventType", sp.point_name AS point, t.reason,
            t.original_transaction_id AS "originalTransactionId",
            t.transaction_time AS "transactionTime", u.name AS "performedBy"
     FROM inventory_history t
     JOIN units pi ON pi.unit_id = t.unit_id
     JOIN users u ON u.user_id = t.user_id
     LEFT JOIN points sp ON sp.point_id = t.point_id
     WHERE t.unit_id = $1 ORDER BY t.transaction_time, t.transaction_id`,
    [instance.rows[0].unit_id],
  );
  res.json({ data: result.rows });
}

async function auditLogs(req, res) {
  const from = req.query.from || null;
  const to = req.query.to || null;
  res.json(await pagedQuery(
    req.query,
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
  ));
}

export { auditLogs, barcodeHistory, stockDetails, summary };
