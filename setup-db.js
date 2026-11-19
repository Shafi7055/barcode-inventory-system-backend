require("dotenv").config();

const fs = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");

async function setupDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set before initializing the database.");
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const schema = await fs.readFile(path.join(__dirname, "schema.sql"), "utf8");
    await pool.query(schema);
    console.log("Database schema is ready for local development.");
  } finally {
    await pool.end();
  }
}

setupDatabase().catch((error) => {
  console.error("Database setup failed:", error.message);
  process.exitCode = 1;
});
