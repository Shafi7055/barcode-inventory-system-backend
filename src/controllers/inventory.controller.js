import { ApiError } from "../errors/api-error.js";
import { integer, requiredString } from "../utils/validation.js";
import {
  getMovement,
  idempotentWrite,
  inTransaction,
  validateStockPoint,
} from "../services/transaction.service.js";

async function trackComponent(req, res) {
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
}

async function receiveStock(req, res) {
  const barcode = requiredString(req.body?.barcode, "barcode", 200);
  const pointId = integer(req.body?.pointId, "pointId", { required: true });
  const productId = integer(req.body?.productId, "productId", { required: true });
  const result = await idempotentWrite(req, 201, async (client) => {
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
  res.status(result.status).json(result.body);
}

async function deliverStock(req, res) {
  const barcode = requiredString(req.body?.barcode, "barcode", 200);
  const pointId = integer(req.body?.pointId, "pointId", { required: true });
  const result = await idempotentWrite(req, 201, async (client) => {
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
  res.status(result.status).json(result.body);
}

async function reverseTransaction(req, res) {
  const transactionId = integer(req.params.transactionId, "transactionId", { required: true });
  const reason = requiredString(req.body?.reason, "reason", 1000);
  const result = await idempotentWrite(req, 201, async (client) => {
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
  res.status(result.status).json(result.body);
}

export { deliverStock, receiveStock, reverseTransaction, trackComponent };
