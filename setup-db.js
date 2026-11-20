import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";
import { importLegacyData } from "./migrate-legacy.js";

const directory = path.dirname(fileURLToPath(import.meta.url));

async function setupDatabase() {
  const client = await pool.connect();
  try {
    const schema = await fs.readFile(path.join(directory, "schema.sql"), "utf8");
    await client.query(schema);
    console.log("Database schema is ready for local development.");
    if (await importLegacyData(client)) {
      console.log("Legacy inventory data was copied into the API schema; source tables were left unchanged.");
    }
  } finally {
    client.release();
    await pool.end();
  }
}

setupDatabase().catch((error) => {
  console.error("Database setup failed:", error);
  process.exitCode = 1;
});
