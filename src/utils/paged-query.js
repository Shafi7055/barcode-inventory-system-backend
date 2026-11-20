import { pool } from "../../db.js";
import { validatePage } from "./validation.js";

async function pagedQuery(query, countSql, rowsSql, values = []) {
  const { page, pageSize, offset } = validatePage(query);
  const count = await pool.query(countSql, values);
  const rows = await pool.query(rowsSql, [...values, pageSize, offset]);
  const totalItems = Number(count.rows[0].total);
  return {
    data: rows.rows,
    meta: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) },
  };
}

export { pagedQuery };
