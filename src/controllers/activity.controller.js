import { pool } from "../../db.js";
import { pagedQuery } from "../utils/paged-query.js";

function activityUserId(req) {
  return req.actor.role === "Admin" ? null : req.actor.id;
}

async function trackedProducts(req, res) {
  const userId = activityUserId(req);
  res.json(await pagedQuery(
    req.query,
    `SELECT COUNT(DISTINCT h.unit_id)::integer AS total
     FROM inventory_history h
     WHERE h.event_type = 'COMPONENT'
       AND ($1::integer IS NULL OR h.user_id = $1)`,
    `WITH tracked AS (
       SELECT DISTINCT ON (h.unit_id)
              h.unit_id, h.transaction_time AS last_tracked_at, h.user_id
       FROM inventory_history h
       WHERE h.event_type = 'COMPONENT'
         AND ($1::integer IS NULL OR h.user_id = $1)
       ORDER BY h.unit_id, h.transaction_time DESC, h.transaction_id DESC
     )
     SELECT un.unit_id AS "unitId", un.barcode, p.product_name AS "productName",
            COUNT(uc.id)::integer AS "trackedComponents",
            t.last_tracked_at AS "lastTrackedAt", tracker.name AS "trackedBy"
     FROM tracked t
     JOIN units un ON un.unit_id = t.unit_id
     JOIN products p ON p.product_id = un.product_id
     JOIN users tracker ON tracker.user_id = t.user_id
     LEFT JOIN unit_components uc ON uc.unit_id = un.unit_id AND uc.is_active = TRUE
     GROUP BY un.unit_id, un.barcode, p.product_name, t.last_tracked_at, tracker.name
     ORDER BY t.last_tracked_at DESC, un.unit_id DESC
     LIMIT $2 OFFSET $3`,
    [userId],
  ));
}

async function receivedProducts(req, res) {
  const userId = activityUserId(req);
  res.json(await pagedQuery(
    req.query,
    `SELECT COUNT(*)::integer AS total
     FROM inventory_history h
     WHERE h.event_type = 'RECEIVED'
       AND ($1::integer IS NULL OR h.user_id = $1)`,
    `SELECT h.transaction_id AS id, un.unit_id AS "unitId", un.barcode,
            p.product_name AS "productName", pt.point_name AS "receivePoint",
            h.transaction_time AS "receivedAt", un.status, u.name AS "receivedBy"
     FROM inventory_history h
     JOIN units un ON un.unit_id = h.unit_id
     JOIN products p ON p.product_id = un.product_id
     JOIN users u ON u.user_id = h.user_id
     LEFT JOIN points pt ON pt.point_id = h.point_id
     WHERE h.event_type = 'RECEIVED'
       AND ($1::integer IS NULL OR h.user_id = $1)
     ORDER BY h.transaction_time DESC, h.transaction_id DESC
     LIMIT $2 OFFSET $3`,
    [userId],
  ));
}

async function deliveredProducts(req, res) {
  const userId = activityUserId(req);
  res.json(await pagedQuery(
    req.query,
    `SELECT COUNT(*)::integer AS total
     FROM inventory_history h
     WHERE h.event_type = 'DELIVERED'
       AND ($1::integer IS NULL OR h.user_id = $1)`,
    `SELECT h.transaction_id AS id, un.unit_id AS "unitId", un.barcode,
            p.product_name AS "productName", pt.point_name AS "deliveryPoint",
            h.transaction_time AS "deliveredAt", un.status, u.name AS "deliveredBy"
     FROM inventory_history h
     JOIN units un ON un.unit_id = h.unit_id
     JOIN products p ON p.product_id = un.product_id
     JOIN users u ON u.user_id = h.user_id
     LEFT JOIN points pt ON pt.point_id = h.point_id
     WHERE h.event_type = 'DELIVERED'
       AND ($1::integer IS NULL OR h.user_id = $1)
     ORDER BY h.transaction_time DESC, h.transaction_id DESC
     LIMIT $2 OFFSET $3`,
    [userId],
  ));
}

export { deliveredProducts, receivedProducts, trackedProducts };
