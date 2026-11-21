import { pathToFileURL } from "node:url";
import { pool } from "./db.js";
import { app } from "./src/app.js";

const PORT = Number(process.env.PORT) || 4001;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.NODE_ENV === "production") {
    console.error("This local API build cannot run in production.");
    process.exitCode = 1;
  } else {
    app.listen(PORT, "127.0.0.1", () => console.log(`Local Barcode Inventory API listening on 127.0.0.1:${PORT}.`));
  }
}

export { app, pool };
