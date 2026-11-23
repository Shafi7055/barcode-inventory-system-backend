import { ApiError } from "../errors/api-error.js";
import { integer, requiredString } from "../utils/validation.js";
import {
  getMovement,
  idempotentWrite,
  inTransaction,
  validateStockPoint,
} from "../services/transaction.service.js";

const UNIT_BARCODE_PATTERN = /^([A-Z]{3})-\d{8}$/;
const COMPONENT_BARCODE_PATTERN = /^([A-Z]{3})-([A-Z]{3})-\d{8}$/;

async function trackComponent(req, res) {
  const productBarcode = requiredString(req.body?.productBarcode, "productBarcode", 200);
  const componentBarcode = requiredString(req.body?.componentBarcode, "componentBarcode", 200);
  const unitBarcodeMatch = UNIT_BARCODE_PATTERN.exec(productBarcode);
  const componentBarcodeMatch = COMPONENT_BARCODE_PATTERN.exec(componentBarcode);
  if (!componentBarcodeMatch) {
    throw new ApiError(422, "VALIDATION_ERROR", "Component barcode must use the format PRD-CMP-00000001.");
  }

  const result = await inTransaction(async (client) => {
    let unit = await client.query(
      `SELECT u.unit_id, u.product_id, u.status, p.product_code
       FROM units u JOIN products p ON p.product_id = u.product_id
       WHERE u.barcode = $1 FOR UPDATE OF u`,
      [productBarcode],
    );
    if (!unit.rowCount) {
      if (!unitBarcodeMatch) {
        throw new ApiError(422, "VALIDATION_ERROR", "Product unit barcode must use the format PRD-00000001.");
      }
      const product = await client.query(
        "SELECT product_id, product_code FROM products WHERE product_code = $1 AND is_active = TRUE",
        [unitBarcodeMatch[1]],
      );
      if (!product.rowCount) throw new ApiError(404, "NOT_FOUND", "No active product matches the product unit barcode prefix.");
      await client.query(
        `INSERT INTO units (product_id, barcode, status)
         VALUES ($1, $2, 'PENDING_RECEIPT')
         ON CONFLICT (barcode) DO NOTHING`,
        [product.rows[0].product_id, productBarcode],
      );
      unit = await client.query(
        `SELECT u.unit_id, u.product_id, u.status, p.product_code
         FROM units u JOIN products p ON p.product_id = u.product_id
         WHERE u.barcode = $1 FOR UPDATE OF u`,
        [productBarcode],
      );
      if (!unit.rowCount || unit.rows[0].product_id !== product.rows[0].product_id) {
        throw new ApiError(409, "CONFLICT", "This product unit barcode is already registered to another product.");
      }
    }

    const [componentProductCode, componentCode] = componentBarcodeMatch.slice(1);
    if (componentProductCode !== unit.rows[0].product_code) {
      throw new ApiError(422, "COMPONENT_PRODUCT_MISMATCH", "This component barcode belongs to a different product type.");
    }
    if (unit.rows[0].status !== "PENDING_RECEIPT") {
      throw new ApiError(409, "CONFLICT", "Components must be tracked before the product unit is received.");
    }
    const component = await client.query(
      "SELECT component_id FROM components WHERE component_code = $1 AND is_active = TRUE",
      [componentCode],
    );
    if (!component.rowCount) throw new ApiError(404, "NOT_FOUND", "No active component matches the component barcode.");
    const barcodeUse = await client.query(
      "SELECT unit_id FROM unit_components WHERE component_barcode = $1",
      [componentBarcode],
    );
    if (barcodeUse.rowCount) {
      throw new ApiError(409, "CONFLICT", "This component barcode has already been tracked.");
    }
    const inserted = await client.query(
      `INSERT INTO unit_components (unit_id, component_id, component_barcode)
       VALUES ($1, $2, $3) ON CONFLICT (unit_id, component_id) DO NOTHING
       RETURNING id, unit_id AS "unitId", component_id AS "componentId", created_at AS "createdAt"`,
      [unit.rows[0].unit_id, component.rows[0].component_id, componentBarcode],
    );
    if (!inserted.rowCount) throw new ApiError(409, "CONFLICT", "This component type is already tracked for the product unit.");
    await client.query(
      `INSERT INTO inventory_history (unit_id, event_type, user_id)
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
  const productId = req.body?.productId === undefined
    ? null
    : integer(req.body.productId, "productId", { required: true });
  const result = await idempotentWrite(req, 201, async (client) => {
    await validateStockPoint(client, pointId, "RECEIVE");
    const found = await client.query("SELECT * FROM units WHERE barcode = $1 FOR UPDATE", [barcode]);
    if (!found.rowCount) {
      throw new ApiError(404, "NOT_FOUND", "Product unit not found. Track its components before receiving it.");
    }
    const unit = found.rows[0];
    if (productId !== null && unit.product_id !== productId) {
      throw new ApiError(409, "CONFLICT", "Product unit barcode does not match the selected product.");
    }
    if (unit.status === "IN_STOCK") throw new ApiError(409, "CONFLICT", "This item is already in stock.");
    if (unit.status === "PENDING_RECEIPT") {
      const trackedComponent = await client.query(
        "SELECT 1 FROM unit_components WHERE unit_id = $1 AND is_active = TRUE LIMIT 1",
        [unit.unit_id],
      );
      if (!trackedComponent.rowCount) {
        throw new ApiError(409, "CONFLICT", "Track at least one component before receiving this product unit.");
      }
    }
    await client.query(
      "UPDATE units SET status = 'IN_STOCK', receive_point_id = $2 WHERE unit_id = $1",
      [unit.unit_id, pointId],
    );
    const movement = await client.query(
      `INSERT INTO inventory_history (unit_id, event_type, point_id, user_id)
       VALUES ($1, 'RECEIVED', $2, $3) RETURNING transaction_id`,
      [unit.unit_id, pointId, req.actor.id],
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
    const unit = await client.query("SELECT * FROM units WHERE barcode = $1 FOR UPDATE", [barcode]);
    if (!unit.rowCount) throw new ApiError(404, "NOT_FOUND", "Product barcode was not found.");
    if (unit.rows[0].status !== "IN_STOCK") throw new ApiError(409, "CONFLICT", "Only items in stock can be delivered.");
    await client.query("UPDATE units SET status = 'DELIVERED' WHERE unit_id = $1", [unit.rows[0].unit_id]);
    const movement = await client.query(
      `INSERT INTO inventory_history (unit_id, event_type, point_id, user_id)
       VALUES ($1, 'DELIVERED', $2, $3) RETURNING transaction_id`,
      [unit.rows[0].unit_id, pointId, req.actor.id],
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
      "SELECT * FROM inventory_history WHERE transaction_id = $1 FOR UPDATE",
      [transactionId],
    );
    if (!original.rowCount) throw new ApiError(404, "NOT_FOUND", "Transaction not found.");
    const transaction = original.rows[0];
    if (!["RECEIVED", "DELIVERED"].includes(transaction.event_type)) {
      throw new ApiError(409, "CONFLICT", "Only receipt or delivery transactions can be reversed.");
    }
    const instance = await client.query(
      "SELECT status FROM units WHERE unit_id = $1 FOR UPDATE",
      [transaction.unit_id],
    );
    if (!instance.rowCount) throw new ApiError(404, "NOT_FOUND", "Inventory item not found.");
    const later = await client.query(
      `SELECT transaction_id FROM inventory_history
       WHERE unit_id = $1 AND transaction_id > $2
         AND event_type IN ('RECEIVED', 'DELIVERED', 'REVERSED')
       LIMIT 1`,
      [transaction.unit_id, transactionId],
    );
    if (later.rowCount) throw new ApiError(409, "CONFLICT", "Reverse later inventory activity first.");
    const alreadyReversed = await client.query(
      "SELECT transaction_id FROM inventory_history WHERE original_transaction_id = $1",
      [transactionId],
    );
    if (alreadyReversed.rowCount) throw new ApiError(409, "CONFLICT", "This transaction has already been reversed.");
    const nextStatus = transaction.event_type === "DELIVERED" ? "IN_STOCK" : "PENDING_RECEIPT";
    const expectedCurrentStatus = transaction.event_type === "DELIVERED" ? "DELIVERED" : "IN_STOCK";
    if (instance.rows[0].status !== expectedCurrentStatus) {
      throw new ApiError(409, "CONFLICT", "The item's current status no longer matches this transaction.");
    }
    await client.query("UPDATE units SET status = $2 WHERE unit_id = $1", [transaction.unit_id, nextStatus]);
    const reversal = await client.query(
      `INSERT INTO inventory_history
         (unit_id, event_type, point_id, user_id, reason, original_transaction_id)
       VALUES ($1, 'REVERSED', $2, $3, $4, $5) RETURNING transaction_id`,
      [transaction.unit_id, transaction.point_id, req.actor.id, reason, transactionId],
    );
    return { data: await getMovement(client, reversal.rows[0].transaction_id) };
  });
  res.status(result.status).json(result.body);
}

export { deliverStock, receiveStock, reverseTransaction, trackComponent };
