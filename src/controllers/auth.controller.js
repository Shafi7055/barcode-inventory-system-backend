import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { pool } from "../../db.js";
import { ApiError } from "../errors/api-error.js";
import { requiredString } from "../utils/validation.js";
import { inTransaction, writeAudit } from "../services/transaction.service.js";

const SESSION_COOKIE = "inventory_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/v1",
    maxAge: SESSION_TTL_MS,
  };
}

function getSessionToken(req) {
  const cookies = req.get("Cookie") || "";
  const entry = cookies.split(";").map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
  return entry ? entry.slice(SESSION_COOKIE.length + 1) : null;
}

function hashSession(token) {
  return createHash("sha256").update(token).digest("hex");
}

function safeUser(user) {
  return { id: user.id, name: user.name, username: user.username, role: user.role };
}

async function login(req, res) {
  const username = requiredString(req.body?.username, "username", 64).toLowerCase();
  const password = req.body?.password;
  if (typeof password !== "string" || password.length > 128) {
    throw new ApiError(422, "VALIDATION_ERROR", "Password is required.");
  }
  const result = await pool.query(
    `SELECT u.user_id AS id, u.name, u.username, u.password_hash, r.role_name AS role
     FROM users u JOIN roles r ON r.role_id = u.role_id
     WHERE LOWER(u.username) = $1 AND u.is_active = TRUE`,
    [username],
  );
  const user = result.rows[0];
  if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Username or password is incorrect.");
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await inTransaction(async (client) => {
    await client.query(
      "DELETE FROM auth_sessions WHERE expires_at <= NOW()",
    );
    await client.query(
      `INSERT INTO auth_sessions (session_hash, user_id, expires_at)
       VALUES ($1, $2, $3)`,
      [hashSession(token), user.id, expiresAt],
    );
    await writeAudit(client, user.id, "LOGIN", "auth_sessions", { username: user.username });
  });
  res.cookie(SESSION_COOKIE, token, cookieOptions());
  res.json({ data: safeUser(user) });
}

async function logout(req, res) {
  const token = getSessionToken(req);
  if (token) {
    await inTransaction(async (client) => {
      const session = await client.query(
        "SELECT user_id FROM auth_sessions WHERE session_hash = $1",
        [hashSession(token)],
      );
      await client.query("DELETE FROM auth_sessions WHERE session_hash = $1", [hashSession(token)]);
      if (session.rowCount) {
        await writeAudit(client, session.rows[0].user_id, "LOGOUT", "auth_sessions", {});
      }
    });
  }
  res.clearCookie(SESSION_COOKIE, cookieOptions());
  res.status(204).end();
}

function currentUser(req, res) {
  res.json({ data: safeUser(req.actor) });
}

async function changePassword(req, res) {
  const currentPassword = req.body?.currentPassword;
  const newPassword = req.body?.newPassword;
  if (typeof currentPassword !== "string" || typeof newPassword !== "string" || newPassword.length < 12 || newPassword.length > 128) {
    throw new ApiError(422, "VALIDATION_ERROR", "Provide your current password and a new password of at least 12 characters.");
  }
  await inTransaction(async (client) => {
    const result = await client.query(
      "SELECT password_hash FROM users WHERE user_id = $1 AND is_active = TRUE FOR UPDATE",
      [req.actor.id],
    );
    if (!result.rowCount || !result.rows[0].password_hash
      || !(await bcrypt.compare(currentPassword, result.rows[0].password_hash))) {
      throw new ApiError(401, "INVALID_CREDENTIALS", "Current password is incorrect.");
    }
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await client.query(
      "UPDATE users SET password_hash = $2, updated_at = NOW() WHERE user_id = $1",
      [req.actor.id, passwordHash],
    );
    await writeAudit(client, req.actor.id, "PASSWORD_CHANGE", "users", { passwordChanged: true });
    await client.query("DELETE FROM auth_sessions WHERE user_id = $1", [req.actor.id]);
  });
  res.clearCookie(SESSION_COOKIE, cookieOptions());
  res.status(204).end();
}

async function registerViewer(req, res) {
  const name = requiredString(req.body?.name, "name", 200);
  const username = requiredString(req.body?.username, "username", 64).toLowerCase();
  const password = req.body?.password;
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
    throw new ApiError(422, "VALIDATION_ERROR", "Username must be 3-64 letters, numbers, periods, underscores, or hyphens.");
  }
  if (typeof password !== "string" || password.length < 12 || password.length > 128) {
    throw new ApiError(422, "VALIDATION_ERROR", "Password must contain 12-128 characters.");
  }
  const role = await pool.query("SELECT role_id FROM roles WHERE role_name = 'Report Viewer'");
  const passwordHash = await bcrypt.hash(password, 12);
  await inTransaction(async (client) => {
    const user = await client.query(
      `INSERT INTO users (name, username, password_hash, role_id)
       VALUES ($1, $2, $3, $4) RETURNING user_id`,
      [name, username, passwordHash, role.rows[0].role_id],
    );
    await writeAudit(client, user.rows[0].user_id, "REGISTER", "users", {
      name,
      username,
      role: "Report Viewer",
    });
  });
  res.status(201).json({ data: { name, username, role: "Report Viewer" } });
}

export { changePassword, currentUser, login, logout, registerViewer };
