import { ApiError } from "../errors/api-error.js";

function integer(value, field, { required = false } = {}) {
  if ((value === undefined || value === null || value === "") && !required) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ApiError(422, "VALIDATION_ERROR", `${field} must be a positive integer.`, [{ field, message: "Must be a positive integer." }]);
  }
  return parsed;
}

function requiredString(value, field, maxLength = 1000) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new ApiError(422, "VALIDATION_ERROR", `${field} is required and must be at most ${maxLength} characters.`, [{ field, message: "Enter a valid value." }]);
  }
  return value.trim();
}

function validatePage(query) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const pageSize = query.pageSize === undefined ? 25 : Number(query.pageSize);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid pagination values.", [
      { field: "page", message: "Page must be a positive integer." },
      { field: "pageSize", message: "Page size must be from 1 to 100." },
    ]);
  }
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export { integer, requiredString, validatePage };
