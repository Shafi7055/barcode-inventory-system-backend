import { ApiError } from "../errors/api-error.js";

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const status = error instanceof ApiError ? error.status : error.code === "23505" ? 409 : 500;
  if (status === 500) console.error(`[${req.requestId}]`, error);
  res.status(status).json({
    error: {
      code: error instanceof ApiError ? error.code : error.code === "23505" ? "CONFLICT" : "INTERNAL_ERROR",
      message: error instanceof ApiError
        ? error.message
        : error.code === "23505"
          ? "A record with the same unique value already exists."
          : "An unexpected server error occurred.",
      requestId: req.requestId,
      ...(error instanceof ApiError && error.details ? { details: error.details } : {}),
    },
  });
}

export { errorHandler };
