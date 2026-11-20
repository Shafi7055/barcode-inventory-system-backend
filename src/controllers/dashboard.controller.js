import { pool } from "../../db.js";

async function getDashboard(_req, res) {
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
}

export { getDashboard };
