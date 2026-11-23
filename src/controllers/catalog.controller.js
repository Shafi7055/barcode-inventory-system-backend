import { pool } from "../../db.js";
import { ApiError } from "../errors/api-error.js";
import { pagedQuery } from "../utils/paged-query.js";
import { integer, requiredString } from "../utils/validation.js";
import { inTransaction, writeAudit } from "../services/transaction.service.js";

async function listProducts(req, res) {
  res.json(await pagedQuery(
    req.query,
    "SELECT COUNT(*)::integer AS total FROM products WHERE is_active = TRUE",
    `SELECT product_id AS id, product_name AS name, product_code AS code,
            description, required_component_codes AS "requiredComponentCodes",
            is_active AS "isActive", created_at AS "createdAt"
     FROM products WHERE is_active = TRUE ORDER BY product_name
     LIMIT $1 OFFSET $2`,
  ));
}

async function createProduct(req, res) {
  const name = requiredString(req.body?.name, "name", 200);
  const code = requiredString(req.body?.code, "code", 100);
  const description = typeof req.body.description === "string" ? req.body.description.trim() : null;
  const product = await inTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO products (product_name, product_code, description)
       VALUES ($1, $2, $3)
       RETURNING product_id AS id, product_name AS name, product_code AS code,
                 description, required_component_codes AS "requiredComponentCodes",
                 is_active AS "isActive", created_at AS "createdAt"`,
      [name, code, description],
    );
    await writeAudit(client, req.actor.id, "CREATE", "products", result.rows[0]);
    return result.rows[0];
  }); 
  res.status(201).json({ data: product });
}

async function setProductRequiredComponents(req, res) {
  const productId = integer(req.params.productId, "productId", { required: true });
  if (!Array.isArray(req.body?.componentCodes) || req.body.componentCodes.length === 0) {
    throw new ApiError(422, "VALIDATION_ERROR", "Select at least one required component.");
  }
  const componentCodes = req.body.componentCodes.map((code, index) =>
    requiredString(code, `componentCodes[${index}]`, 100));
  if (new Set(componentCodes).size !== componentCodes.length) {
    throw new ApiError(422, "VALIDATION_ERROR", "Required components cannot contain duplicates.");
  }

  const product = await inTransaction(async (client) => {
    const previousResult = await client.query(
      `SELECT product_id AS id, product_name AS name, product_code AS code,
              required_component_codes AS "requiredComponentCodes"
       FROM products WHERE product_id = $1 FOR UPDATE`,
      [productId],
    );
    if (!previousResult.rowCount) throw new ApiError(404, "NOT_FOUND", "Product not found.");

    const available = await client.query(
      "SELECT component_code FROM components WHERE component_code = ANY($1::text[]) AND is_active = TRUE",
      [componentCodes],
    );
    if (available.rowCount !== componentCodes.length) {
      const availableCodes = new Set(available.rows.map((row) => row.component_code));
      const invalid = componentCodes.filter((code) => !availableCodes.has(code));
      throw new ApiError(422, "VALIDATION_ERROR", `Unknown or inactive components: ${invalid.join(", ")}.`);
    }

    const updated = await client.query(
      `UPDATE products SET required_component_codes = $2::text[]
       WHERE product_id = $1
       RETURNING product_id AS id, product_name AS name, product_code AS code,
                 required_component_codes AS "requiredComponentCodes"`,
      [productId, componentCodes],
    );
    await writeAudit(
      client,
      req.actor.id,
      "UPDATE",
      "products",
      updated.rows[0],
      previousResult.rows[0],
    );
    return updated.rows[0];
  });
  res.json({ data: product });
}

async function listComponents(req, res) {
  res.json(await pagedQuery(
    req.query,
    "SELECT COUNT(*)::integer AS total FROM components WHERE is_active = TRUE",
    `SELECT component_id AS id, component_name AS name, component_code AS code,
            component_barcode AS barcode, is_active AS "isActive", created_at AS "createdAt"
     FROM components WHERE is_active = TRUE ORDER BY component_name
     LIMIT $1 OFFSET $2`,
  ));
}

async function createComponent(req, res) {
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
}

async function listStockPoints(req, res) {
  const type = req.query.type;
  if (!["RECEIVE", "DELIVERY"].includes(type)) {
    throw new ApiError(422, "VALIDATION_ERROR", "type must be RECEIVE or DELIVERY.");
  }
  const result = await pool.query(
    `SELECT point_id AS id, point_name AS name, point_type AS type, is_active AS "isActive"
     FROM points WHERE point_type = $1 AND is_active = TRUE ORDER BY point_name`,
    [type],
  );
  res.json({ data: result.rows });
}

async function createStockPoint(req, res) {
  const name = requiredString(req.body?.name, "name", 200);
  const type = req.body?.type;
  if (!["RECEIVE", "DELIVERY"].includes(type)) {
    throw new ApiError(422, "VALIDATION_ERROR", "type must be RECEIVE or DELIVERY.");
  }
  const point = await inTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO points (point_name, point_type)
       VALUES ($1, $2)
       RETURNING point_id AS id, point_name AS name, point_type AS type, is_active AS "isActive"`,
      [name, type],
    );
    await writeAudit(client, req.actor.id, "CREATE", "points", result.rows[0]);
    return result.rows[0];
  });
  res.status(201).json({ data: point });
}

export {
  createComponent,
  createProduct,
  createStockPoint,
  listComponents,
  listProducts,
  listStockPoints,
  setProductRequiredComponents,
};
