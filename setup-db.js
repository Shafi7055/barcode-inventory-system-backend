require("dotenv").config();

const fs = require("node:fs/promises");
const path = require("node:path");
const { pool } = require("./db");

async function setupDatabase() {
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
