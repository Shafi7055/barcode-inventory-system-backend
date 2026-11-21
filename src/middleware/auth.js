import { createHmac } from "node:crypto";
import { pool } from "../../db.js";
import { ApiError } from "../errors/api-error.js";
import { permissionsForRole } from "../auth/roles.js";
import { verifySessionToken } from "../controllers/auth.controller.js";

const SESSION_COOKIE = "inventory_session";

function sessionToken(req) {
  const cookies = req.get("Cookie") || "";
  const entry = cookies.split(";").map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
  return entry ? entry.slice(SESSION_COOKIE.length + 1) : null;
}

function sessionSecret() {
  return process.env.SESSION_SECRET || "local-development-session-secret-change-me";
}

function requireAuth(req, _res, next) {
  const token = sessionToken(req);
  if (!token) return next(new ApiError(401, "UNAUTHENTICATED", "Sign in to continue."));

  const session = verifySessionToken(token);
  if (!session) return next(new ApiError(401, "UNAUTHENTICATED", "Your session has expired. Sign in again."));

  pool.query(
    `SELECT u.user_id AS id, u.name, u.username, u.password_hash, r.role_name AS role
     FROM users u
     JOIN roles r ON r.role_id = u.role_id
     WHERE u.user_id = $1 AND u.is_active = TRUE`,
    [session.userId],
  ).then((result) => {
    if (!result.rowCount) throw new ApiError(401, "UNAUTHENTICATED", "Your session has expired. Sign in again.");
    const user = result.rows[0];
    const passwordVersion = createHmac("sha256", sessionSecret())
      .update(user.password_hash || "")
      .digest("base64url");
    if (passwordVersion !== session.passwordVersion) {
      throw new ApiError(401, "UNAUTHENTICATED", "Your session is no longer valid. Sign in again.");
    }
    req.actor = { ...user, permissions: permissionsForRole(user.role) };
    next();
  }).catch(next);
}

function requirePermission(permission) {
  return (req, _res, next) => {
    if (req.actor?.permissions.includes("*") || req.actor?.permissions.includes(permission)) return next();
    next(new ApiError(403, "FORBIDDEN", "You do not have permission to perform this action."));
  };
}

function requireStockPointRead(req, _res, next) {
  const permission = req.query.type === "RECEIVE"
    ? "stock-points:receive"
    : req.query.type === "DELIVERY"
      ? "stock-points:delivery"
      : null;
  if (!permission || req.actor?.permissions.includes("*") || req.actor?.permissions.includes(permission)) {
    return next();
  }
  next(new ApiError(403, "FORBIDDEN", "You do not have permission to view this stock-point type."));
}

export { requireAuth, requirePermission, requireStockPointRead };
