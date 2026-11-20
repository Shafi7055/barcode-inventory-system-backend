import "dotenv/config";

import pg from "pg";

const { Pool } = pg;

function getDatabaseConfig() {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      options: "-c search_path=barcode_inventory",
    };
  }

  const required = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`Missing PostgreSQL environment variables: ${missing.join(", ")}`);
  }

  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: "-c search_path=barcode_inventory",
  };
}

const pool = new Pool(getDatabaseConfig());

export { pool };
