import { ApiError } from "../errors/api-error.js";

function validateUsername(username) {
  // checks valid username: 3-64 characters, lowercase letters, numbers, periods, underscores, or hyphens
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
    throw new ApiError(422, "VALIDATION_ERROR", "Username must be 3-64 letters, numbers, periods, underscores, or hyphens.");
  }
}

function validatePassword(password) {
  // checks valid password: 12-128 characters
  if (typeof password !== "string" || password.length < 12 || password.length > 128) {
    throw new ApiError(422, "VALIDATION_ERROR", "Password must contain 12-128 characters.");
  }
}

export { validatePassword, validateUsername };
