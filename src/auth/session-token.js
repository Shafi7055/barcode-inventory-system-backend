import { createHmac, timingSafeEqual } from "node:crypto";

function sessionSecret() {
  return process.env.SESSION_SECRET || "local-development-session-secret-change-me";
}

function passwordVersion(passwordHash) {
  return createHmac("sha256", sessionSecret())
    .update(passwordHash || "")
    .digest("base64url");
}

function createSessionToken(userId, expiresAt, passwordHash) {
  const payload = `${userId}.${expiresAt}.${passwordVersion(passwordHash)}`;
  const signature = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifySessionToken(token) {
  const separator = token.lastIndexOf(".");
  if (separator < 1) return null;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;

  const parts = payload.split(".");
  if (parts.length !== 3) return null;
  const [userId, expiresAt, storedPasswordVersion] = parts;
  const expiry = Number(expiresAt);
  if (!/^\d+$/.test(userId) || !Number.isFinite(expiry) || expiry <= Date.now()) return null;
  return { userId: Number(userId), passwordVersion: storedPasswordVersion };
} 

export { createSessionToken, passwordVersion, verifySessionToken };
