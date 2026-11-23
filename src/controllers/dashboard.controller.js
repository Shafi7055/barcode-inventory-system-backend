import { pool } from "../../db.js";
import { MOVEMENT_SELECT } from "../services/transaction.service.js";

async function getDashboard(_req, res) {
  const [stock, received, delivered, recent] = await Promise.all([
    pool.query("SELECT COUNT(*)::integer AS total FROM units WHERE status = 'IN_STOCK'"),
    pool.query(
      "SELECT COUNT(*)::integer AS total FROM inventory_history WHERE event_type = 'RECEIVED' AND transaction_time >= CURRENT_DATE",
    ),
    pool.query(
      "SELECT COUNT(*)::integer AS total FROM inventory_history WHERE event_type = 'DELIVERED' AND transaction_time >= CURRENT_DATE",
    ),
    pool.query(`${MOVEMENT_SELECT} ORDER BY t.transaction_time DESC, t.transaction_id DESC LIMIT 10`),
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
