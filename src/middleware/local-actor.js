import { pool } from "../../db.js";
import { ApiError } from "../errors/api-error.js";

async function localActor(req, _res, next) {
  try {
    const result = await pool.query(
      "SELECT user_id FROM users WHERE is_system = TRUE",
    );
    if (!result.rowCount) {
      throw new ApiError(503, "NOT_READY", "Run npm run db:setup to prepare the local API.");
    }
    req.actor = { id: result.rows[0].user_id };
    next();
  } catch (error) {
    next(error);
  }
}

export { localActor };
