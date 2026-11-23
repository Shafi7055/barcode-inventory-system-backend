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

async function missingRequiredComponents(client, unit) {
  const requiredCodes = unit.required_component_codes;
  if (!Array.isArray(requiredCodes) || requiredCodes.length === 0) {
    throw new ApiError(
      409,
      "COMPONENT_REQUIREMENTS_NOT_CONFIGURED",
      "Required components are not configured for this product. Ask an Admin to configure them.",
    );
  }

  return client.query(
    `SELECT c.component_code AS code, c.component_name AS name
     FROM unnest($1::text[]) WITH ORDINALITY AS required(code, position)
     JOIN components c ON c.component_code = required.code
     LEFT JOIN unit_components uc
       ON uc.unit_id = $2 AND uc.component_id = c.component_id AND uc.is_active = TRUE
     WHERE uc.id IS NULL OR uc.received_at IS NULL OR uc.received_by IS NULL
       OR uc.received_point_id IS NULL
     ORDER BY required.position`,
    [requiredCodes, unit.unit_id],
  );
}

async function assertRequiredComponentsReceived(client, unit) {
  const missing = await missingRequiredComponents(client, unit);
  if (missing.rowCount) {
    const componentNames = missing.rows.map((component) => `${component.name} (${component.code})`);
    throw new ApiError(
      409,
      "MISSING_COMPONENTS",
      `This product unit cannot be delivered yet. Components not received: ${componentNames.join(", ")}.`,
    );
  }
}

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
      `SELECT u.unit_id, u.product_id, u.status, p.product_code, p.required_component_codes
       FROM units u JOIN products p ON p.product_id = u.product_id
       WHERE u.barcode = $1 FOR UPDATE OF u`,
      [productBarcode],
    );
    if (!unit.rowCount) {
      if (!unitBarcodeMatch) {
        throw new ApiError(422, "VALIDATION_ERROR", "Product unit barcode must use the format PRD-00000001.");
      }
      const product = await client.query(
        `SELECT product_id, product_code, required_component_codes
         FROM products WHERE product_code = $1 AND is_active = TRUE`,
        [unitBarcodeMatch[1]],
      );
      if (!product.rowCount) throw new ApiError(404, "NOT_FOUND", "No active product matches the product unit barcode prefix.");
      if (!product.rows[0].required_component_codes.length) {
        throw new ApiError(
          409,
          "COMPONENT_REQUIREMENTS_NOT_CONFIGURED",
          "Required components are not configured for this product. Ask an Admin to configure them.",
        );
      }
      await client.query(
        `INSERT INTO units (product_id, barcode, status)
         VALUES ($1, $2, 'PENDING_RECEIPT')
         ON CONFLICT (barcode) DO NOTHING`,
        [product.rows[0].product_id, productBarcode],
      );
      unit = await client.query(
        `SELECT u.unit_id, u.product_id, u.status, p.product_code, p.required_component_codes
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
    const requiredComponentCodes = unit.rows[0].required_component_codes;
    if (!requiredComponentCodes.length) {
      throw new ApiError(
        409,
        "COMPONENT_REQUIREMENTS_NOT_CONFIGURED",
        "Required components are not configured for this product. Ask an Admin to configure them.",
      );
    }
    if (!requiredComponentCodes.includes(componentCode)) {
      throw new ApiError(
        409,
        "COMPONENT_NOT_REQUIRED",
        `This component is not required for this product. Required component codes: ${requiredComponentCodes.join(", ")}.`,
      );
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
      `INSERT INTO inventory_history (unit_id, event_type, component_id, user_id)
       VALUES ($1, 'COMPONENT', $2, $3)`,
      [unit.rows[0].unit_id, component.rows[0].component_id, req.actor.id],
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
  const productBarcode = requiredString(req.body?.productBarcode, "productBarcode", 200);
  const componentBarcode = requiredString(req.body?.componentBarcode, "componentBarcode", 200);
  const unitBarcodeMatch = UNIT_BARCODE_PATTERN.exec(productBarcode);
  const componentBarcodeMatch = COMPONENT_BARCODE_PATTERN.exec(componentBarcode);
  if (!unitBarcodeMatch) {
    throw new ApiError(422, "INVALID_PRODUCT_UNIT_BARCODE", "Product unit barcode must use the format PRD-00000001.");
  }
  if (!componentBarcodeMatch) {
    throw new ApiError(422, "INVALID_COMPONENT_BARCODE", "Component barcode must use the format PRD-CMP-00000001.");
  }
  const [componentProductCode, componentCode] = componentBarcodeMatch.slice(1);
  if (unitBarcodeMatch[1] !== componentProductCode) {
    throw new ApiError(422, "COMPONENT_PRODUCT_MISMATCH", "This component barcode belongs to a different product type.");
  }
  const pointId = integer(req.body?.pointId, "pointId", { required: true });
  const result = await idempotentWrite(req, 201, async (client) => {
    await validateStockPoint(client, pointId, "RECEIVE");
    const found = await client.query(
      `SELECT un.*, p.product_code, p.required_component_codes
       FROM units un JOIN products p ON p.product_id = un.product_id
       WHERE un.barcode = $1 FOR UPDATE OF un`,
      [productBarcode],
    );
    if (!found.rowCount) {
      throw new ApiError(404, "NOT_FOUND", "Product unit not found. Track its components before receiving it.");
    }
    const unit = found.rows[0];
    if (unit.product_code !== componentProductCode) {
      throw new ApiError(422, "COMPONENT_PRODUCT_MISMATCH", "This component barcode belongs to a different product type.");
    }
    if (unit.status === "DELIVERED") {
      throw new ApiError(409, "CONFLICT", "A delivered product unit cannot receive more components.");
    }
    const requiredCodes = unit.required_component_codes;
    if (!Array.isArray(requiredCodes) || requiredCodes.length === 0) {
      throw new ApiError(
        409,
        "COMPONENT_REQUIREMENTS_NOT_CONFIGURED",
        "Required components are not configured for this product. Ask an Admin to configure them.",
      );
    }
    if (!requiredCodes.includes(componentCode)) {
      throw new ApiError(
        409,
        "COMPONENT_NOT_REQUIRED",
        `This component is not required for this product. Required component codes: ${requiredCodes.join(", ")}.`,
      );
    }

    const foundComponent = await client.query(
      `SELECT uc.id, uc.received_at, uc.received_by,
              c.component_id AS "componentId", c.component_name AS "componentName"
       FROM unit_components uc
       JOIN components c ON c.component_id = uc.component_id
       WHERE uc.unit_id = $1 AND uc.component_barcode = $2
         AND c.component_code = $3 AND c.is_active = TRUE AND uc.is_active = TRUE
       FOR UPDATE OF uc`,
      [unit.unit_id, componentBarcode, componentCode],
    );
    if (!foundComponent.rowCount) {
      throw new ApiError(
        409,
        "COMPONENT_NOT_TRACKED",
        "This component barcode is not tracked on this product unit. Track it in Component Tracking first.",
      );
    }

    if (foundComponent.rows[0].received_at && foundComponent.rows[0].received_by) {
      const missing = await missingRequiredComponents(client, unit);
      return {
        data: {
          productBarcode,
          componentBarcode,
          componentName: foundComponent.rows[0].componentName,
          alreadyReceived: true,
          completed: missing.rowCount === 0,
          receivedCount: requiredCodes.length - missing.rowCount,
          requiredCount: requiredCodes.length,
          missingComponents: missing.rows.map((component) => `${component.name} (${component.code})`),
          status: unit.status,
        },
      };
    }

    await client.query(
      `UPDATE unit_components
       SET received_at = NOW(), received_by = $2, received_point_id = $3
       WHERE id = $1`,
      [foundComponent.rows[0].id, req.actor.id, pointId],
    );
    await client.query(
      `INSERT INTO inventory_history (unit_id, event_type, component_id, point_id, user_id)
       VALUES ($1, 'COMPONENT_RECEIVED', $2, $3, $4)`,
      [unit.unit_id, foundComponent.rows[0].componentId, pointId, req.actor.id],
    );
    const missing = await missingRequiredComponents(client, unit);
    let status = unit.status;
    if (!missing.rowCount && status === "PENDING_RECEIPT") {
      await client.query(
        "UPDATE units SET status = 'IN_STOCK', receive_point_id = $2 WHERE unit_id = $1",
        [unit.unit_id, pointId],
      );
      await client.query(
        `INSERT INTO inventory_history (unit_id, event_type, point_id, user_id)
         VALUES ($1, 'RECEIVED', $2, $3)`,
        [unit.unit_id, pointId, req.actor.id],
      );
      status = "IN_STOCK";
    }
    return {
      data: {
        productBarcode,
        componentBarcode,
        componentName: foundComponent.rows[0].componentName,
        alreadyReceived: false,
        completed: missing.rowCount === 0,
        receivedCount: requiredCodes.length - missing.rowCount,
        requiredCount: requiredCodes.length,
        missingComponents: missing.rows.map((component) => `${component.name} (${component.code})`),
        status,
      },
    };
  });
  res.status(result.status).json(result.body);
}

async function deliverStock(req, res) {
  const barcode = requiredString(req.body?.barcode, "barcode", 200);
  if (!UNIT_BARCODE_PATTERN.test(barcode)) {
    throw new ApiError(
      422,
      "INVALID_PRODUCT_UNIT_BARCODE",
      "Enter a product unit barcode in the format PRD-00000001. Component barcodes cannot be delivered.",
    );
  }
  const pointId = integer(req.body?.pointId, "pointId", { required: true });
  const result = await idempotentWrite(req, 201, async (client) => {
    await validateStockPoint(client, pointId, "DELIVERY");
    const unit = await client.query(
      `SELECT un.*, p.required_component_codes
       FROM units un JOIN products p ON p.product_id = un.product_id
       WHERE un.barcode = $1 FOR UPDATE OF un`,
      [barcode],
    );
    if (!unit.rowCount) throw new ApiError(404, "NOT_FOUND", "Product barcode was not found.");
    await assertRequiredComponentsReceived(client, unit.rows[0]);
    if (unit.rows[0].status !== "IN_STOCK") {
      throw new ApiError(409, "CONFLICT", "This product unit must be received before it can be delivered.");
    }
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
