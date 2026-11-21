import express from "express";
import cors from "cors";
import { pool } from "../db.js";
import { errorHandler } from "./middleware/error-handler.js";
import { requestId } from "./middleware/request-id.js";
import { apiRouter } from "./routes/api.routes.js";
import { authRouter } from "./routes/auth.routes.js";
import { usersRouter } from "./routes/users.routes.js";
import { requireAuth } from "./middleware/auth.js";
import { ApiError } from "./errors/api-error.js";

const app = express();

app.use(requestId);
app.use(cors({
  origin: (process.env.FRONTEND_ORIGIN || "http://localhost:3002").split(",").map((origin) => origin.trim()),
  credentials: true,
  methods: ["GET", "POST", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Idempotency-Key"],
}));
app.use(express.json({ limit: "1mb" }));

app.get("/health", async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ status: "ok" });
});

app.use("/api/v1/auth", authRouter);
app.use("/api/v1/users", requireAuth, usersRouter);
app.use("/api/v1", requireAuth, apiRouter);
app.use("/api", (_req, _res, next) => next(new ApiError(404, "NOT_FOUND", "API route not found.")));
app.use(errorHandler);

export { app };
