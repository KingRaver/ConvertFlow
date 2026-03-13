import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

const API_KEY_BYTES = 32;
const HASH_KEY_LENGTH = 64;
const PASSWORD_HASH_SCHEME = "scrypt";
const SALT_BYTES = 16;
const SESSION_TOKEN_BYTES = 32;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const API_KEY_PREFIX = "cf_";
export const MIN_PASSWORD_LENGTH = 8;

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES).toString("hex");
  const derivedKey = await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, HASH_KEY_LENGTH, (error, key) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(key);
    });
  });

  return `${PASSWORD_HASH_SCHEME}$${salt}$${derivedKey.toString("hex")}`;
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  const [scheme, salt, storedHash] = passwordHash.split("$");
  if (scheme !== PASSWORD_HASH_SCHEME || !salt || !storedHash) {
    return false;
  }

  const derivedKey = await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, HASH_KEY_LENGTH, (error, key) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(key);
    });
  });
  const storedBuffer = Buffer.from(storedHash, "hex");

  if (storedBuffer.length !== derivedKey.length) {
    return false;
  }

  return timingSafeEqual(storedBuffer, derivedKey);
}

export function createSessionToken() {
  return randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

export function createSessionExpiry(now = new Date()) {
  return new Date(now.getTime() + SESSION_TTL_MS);
}

export function createApiKeyToken() {
  return `${API_KEY_PREFIX}${randomBytes(API_KEY_BYTES).toString("base64url")}`;
}

export function hashSecret(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}
