import { pool } from "../../db.js";
import { ApiError } from "../errors/api-error.js";
import { pagedQuery } from "../utils/paged-query.js";
import { requiredString } from "../utils/validation.js";
import { inTransaction, writeAudit } from "../services/transaction.service.js";

async function listProducts(req, res) {
  res.json(await pagedQuery(
    req.query,
    "SELECT COUNT(*)::integer AS total FROM products WHERE is_active = TRUE",
    `SELECT product_id AS id, product_name AS name, product_code AS code,
            description, is_active AS "isActive", created_at AS "createdAt"
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
                 description, is_active AS "isActive", created_at AS "createdAt"`,
      [name, code, description],
    );
    await writeAudit(client, req.actor.id, "CREATE", "products", result.rows[0]);
    return result.rows[0];
  });
  res.status(201).json({ data: product });
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
     FROM stock_points WHERE point_type = $1 AND is_active = TRUE ORDER BY point_name`,
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
      `INSERT INTO stock_points (point_name, point_type)
       VALUES ($1, $2)
       RETURNING point_id AS id, point_name AS name, point_type AS type, is_active AS "isActive"`,
      [name, type],
    );
    await writeAudit(client, req.actor.id, "CREATE", "stock_points", result.rows[0]);
    return result.rows[0];
  });
  res.status(201).json({ data: point });
}

export { createComponent, createProduct, createStockPoint, listComponents, listProducts, listStockPoints };
