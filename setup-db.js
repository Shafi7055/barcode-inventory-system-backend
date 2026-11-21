import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import { pool } from "./db.js";
import { importLegacyAccounts, importLegacyData } from "./migrate-legacy.js";

const directory = path.dirname(fileURLToPath(import.meta.url));

async function ensureBootstrapAdmin(client) {
  const admin = await client.query(
    `SELECT u.user_id FROM users u
     JOIN roles r ON r.role_id = u.role_id
     WHERE r.role_name = 'Admin' AND u.is_active = TRUE AND u.password_hash IS NOT NULL
     LIMIT 1`,
  );
  if (admin.rowCount) return;

  const username = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!username || !password || password.length < 12) {
    throw new Error("Set BOOTSTRAP_ADMIN_USERNAME and a 12-character BOOTSTRAP_ADMIN_PASSWORD to create the first Admin account.");
  }
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
    throw new Error("BOOTSTRAP_ADMIN_USERNAME must be 3-64 letters, numbers, periods, underscores, or hyphens.");
  }
  const existingUser = await client.query("SELECT 1 FROM users WHERE LOWER(username) = $1", [username]);
  if (existingUser.rowCount) {
    throw new Error("BOOTSTRAP_ADMIN_USERNAME is already in use; choose a different username.");
  }

  const role = await client.query("SELECT role_id FROM roles WHERE role_name = 'Admin'");
  const passwordHash = await bcrypt.hash(password, 12);
  await client.query(
    `INSERT INTO users (name, username, password_hash, role_id)
     VALUES ('Administrator', $1, $2, $3)`,
    [username, passwordHash, role.rows[0].role_id],
  );
}

async function setupDatabase() {
  const client = await pool.connect();
  try {
    const schema = await fs.readFile(path.join(directory, "schema.sql"), "utf8");
    await client.query(schema);
    console.log("Database schema is ready for local development.");
    if (await importLegacyData(client)) {
      console.log("Legacy inventory data was copied into the API schema; source tables were left unchanged.");
    }
    if (await importLegacyAccounts(client)) {
      console.log("Legacy accounts and roles were copied without changing source credentials.");
    }
    await ensureBootstrapAdmin(client);
  } finally {
    client.release();
    await pool.end();
  }
}

setupDatabase().catch((error) => {
  console.error("Database setup failed:", error);
  process.exitCode = 1;
});
