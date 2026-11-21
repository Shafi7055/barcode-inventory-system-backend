import bcrypt from "bcryptjs";
import { pool } from "../../db.js";
import { ApiError } from "../errors/api-error.js";
import { integer, requiredString } from "../utils/validation.js";
import { inTransaction, writeAudit } from "../services/transaction.service.js";

async function listUsers(_req, res) {
  const result = await pool.query(
    `SELECT u.user_id AS id, u.name, u.username, u.is_active AS "isActive",
            r.role_name AS role, u.created_at AS "createdAt"
     FROM users u JOIN roles r ON r.role_id = u.role_id
     WHERE u.is_system = FALSE ORDER BY u.name, u.user_id`,
  );
  res.json({ data: result.rows });
}

async function listRoles(_req, res) {
  const result = await pool.query(
    "SELECT role_name AS name FROM roles WHERE role_name <> 'Admin' ORDER BY role_id",
  );
  res.json({ data: result.rows });
}

async function createUser(req, res) {
  const name = requiredString(req.body?.name, "name", 200);
  const username = requiredString(req.body?.username, "username", 64).toLowerCase();
  const roleName = requiredString(req.body?.role, "role", 64);
  const password = req.body?.password;
  validateUsername(username);
  validatePassword(password);

  const user = await inTransaction(async (client) => {
    if (roleName === "Admin") {
      throw new ApiError(409, "CONFLICT", "The Admin role cannot be assigned to additional accounts.");
    }
    const role = await findRole(client, roleName);
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await client.query(
      `INSERT INTO users (name, username, password_hash, role_id)
       VALUES ($1, $2, $3, $4)
       RETURNING user_id AS id, name, username, is_active AS "isActive", created_at AS "createdAt"`,
      [name, username, passwordHash, role.role_id],
    );
    const created = { ...result.rows[0], role: role.role_name };
    await writeAudit(client, req.actor.id, "CREATE", "users", created);
    return created;
  });
  res.status(201).json({ data: user });
}

async function updateUser(req, res) {
  const userId = integer(req.params.userId, "userId", { required: true });
  const { name, role, isActive, password } = req.body || {};
  if (name === undefined && role === undefined && isActive === undefined && password === undefined) {
    throw new ApiError(422, "VALIDATION_ERROR", "Provide at least one user field to update.");
  }
  const nextName = name === undefined ? undefined : requiredString(name, "name", 200);
  const nextRoleName = role === undefined ? undefined : requiredString(role, "role", 64);
  if (isActive !== undefined && typeof isActive !== "boolean") {
    throw new ApiError(422, "VALIDATION_ERROR", "isActive must be a boolean.");
  }
  if (password !== undefined) validatePassword(password);
  const user = await inTransaction(async (client) => {
    const previousResult = await client.query(
      `SELECT u.user_id AS id, u.name, u.username, u.is_active AS "isActive",
              r.role_name AS role
       FROM users u JOIN roles r ON r.role_id = u.role_id
       WHERE u.user_id = $1 AND u.is_system = FALSE FOR UPDATE OF u`,
      [userId],
    );
    if (!previousResult.rowCount) throw new ApiError(404, "NOT_FOUND", "User not found.");
    const previous = previousResult.rows[0];
    if (userId === req.actor.id
      && ((nextRoleName !== undefined && nextRoleName !== previous.role)
        || (isActive === false && previous.isActive))) {
      throw new ApiError(409, "CONFLICT", "You cannot change your own role or deactivate your account.");
    }
    if (nextRoleName === "Admin") {
      throw new ApiError(409, "CONFLICT", "The Admin role cannot be assigned to additional accounts.");
    }
    const nextRole = nextRoleName === undefined ? null : await findRole(client, nextRoleName);
    const resultRole = nextRole?.role_name || previous.role;
    const resultActive = isActive === undefined ? previous.isActive : isActive;
    if (previous.role === "Admin" && (resultRole !== "Admin" || !resultActive) && previous.isActive) {
      await client.query("SELECT pg_advisory_xact_lock(19081, 1)");
      const activeAdmins = await client.query(
        `SELECT COUNT(*)::integer AS total FROM users u
         JOIN roles r ON r.role_id = u.role_id
         WHERE r.role_name = 'Admin' AND u.is_active = TRUE`,
      );
      if (activeAdmins.rows[0].total <= 1) {
        throw new ApiError(409, "CONFLICT", "The last active Admin account cannot be deactivated or demoted.");
      }
    }

    const passwordHash = password === undefined ? null : await bcrypt.hash(password, 12);
    const updated = await client.query(
      `UPDATE users
       SET name = COALESCE($2, name),
           role_id = COALESCE($3, role_id),
           is_active = COALESCE($4, is_active),
           password_hash = COALESCE($5, password_hash),
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING user_id AS id, name, username, is_active AS "isActive",
                 created_at AS "createdAt"`,
      [userId, nextName ?? null, nextRole?.role_id ?? null, isActive ?? null, passwordHash],
    );
    const updatedUser = { ...updated.rows[0], role: resultRole };
    await writeAudit(client, req.actor.id, "UPDATE", "users", updatedUser, previous);
    return updatedUser;
  });
  res.json({ data: user });
}

function validateUsername(username) {
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
    throw new ApiError(422, "VALIDATION_ERROR", "Username must be 3-64 letters, numbers, periods, underscores, or hyphens.");
  }
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 128) {
    throw new ApiError(422, "VALIDATION_ERROR", "Password must contain 12-128 characters.");
  }
}

async function findRole(client, roleName) {
  const result = await client.query("SELECT role_id, role_name FROM roles WHERE role_name = $1", [roleName]);
  if (!result.rowCount) throw new ApiError(422, "VALIDATION_ERROR", "Select one of the defined user roles.");
  return result.rows[0];
}

export { createUser, listRoles, listUsers, updateUser };
