import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FileStore } from "./index";

const DOWNLOAD_TTL_SECONDS = 15 * 60;

function getLocalSigningSecret() {
  const secret = process.env.LOCAL_FILESTORE_SIGNING_SECRET?.trim()
    ?? process.env.SESSION_SECRET?.trim();

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "LOCAL_FILESTORE_SIGNING_SECRET (or SESSION_SECRET) must be set in production.",
      );
    }
    console.warn(
      "[filestore/local] Warning: LOCAL_FILESTORE_SIGNING_SECRET not set. Using insecure default. Set this variable before deploying.",
    );
    return "convertflow-local-filestore-secret";
  }

  return secret;
}

const LOCAL_SIGNING_SECRET = getLocalSigningSecret();

interface LocalDownloadParams {
  expires: number;
  filename: string;
  key: string;
  signature: string;
}

function normalizeStorageKey(key: string) {
  const normalized = path.posix.normalize(key.replace(/\\/g, "/")).replace(/^\/+/, "");

  if (
    normalized.length === 0
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || (!normalized.startsWith("uploads/") && !normalized.startsWith("outputs/"))
  ) {
    throw new Error(`Invalid storage key: ${key}`);
  }

  return normalized;
}

function getLocalPathForKey(key: string) {
  return path.join(process.cwd(), normalizeStorageKey(key));
}

function createSignature(key: string, filename: string, expires: number) {
  return crypto
    .createHmac("sha256", LOCAL_SIGNING_SECRET)
    .update(`${key}\n${filename}\n${expires}`)
    .digest("hex");
}

function isValidSignature(key: string, filename: string, expires: number, signature: string) {
  const expected = createSignature(key, filename, expires);
  const provided = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  if (provided.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(provided, expectedBuffer);
}

export function createLocalDownloadUrl(key: string, filename: string) {
  const normalizedKey = normalizeStorageKey(key);
  const expires = Date.now() + DOWNLOAD_TTL_SECONDS * 1000;
  const signature = createSignature(normalizedKey, filename, expires);
  const params = new URLSearchParams({
    expires: String(expires),
    filename,
    key: normalizedKey,
    signature,
  });

  return `/api/download/local?${params.toString()}`;
}

export function parseLocalDownloadParams(
  rawParams: Record<string, string | string[] | undefined>,
): LocalDownloadParams | null {
  const keyValue = rawParams.key;
  const filenameValue = rawParams.filename;
  const expiresValue = rawParams.expires;
  const signatureValue = rawParams.signature;

  const key = Array.isArray(keyValue) ? keyValue[0] : keyValue;
  const filename = Array.isArray(filenameValue) ? filenameValue[0] : filenameValue;
  const expiresRaw = Array.isArray(expiresValue) ? expiresValue[0] : expiresValue;
  const signature = Array.isArray(signatureValue) ? signatureValue[0] : signatureValue;

  if (!key || !filename || !expiresRaw || !signature) {
    return null;
  }

  const expires = Number.parseInt(expiresRaw, 10);
  if (Number.isNaN(expires) || expires < Date.now()) {
    return null;
  }

  let normalizedKey: string;
  try {
    normalizedKey = normalizeStorageKey(key);
  } catch {
    return null;
  }

  if (!/^[0-9a-f]+$/i.test(signature) || !isValidSignature(normalizedKey, filename, expires, signature)) {
    return null;
  }

  return {
    expires,
    filename,
    key: normalizedKey,
    signature,
  };
}

export function getLocalPathFromDownloadKey(key: string) {
  return getLocalPathForKey(key);
}

export class LocalFileStore implements FileStore {
  readonly driver = "local" as const;

  async save(localPath: string, key: string) {
    const destinationPath = getLocalPathForKey(key);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(localPath, destinationPath);
    console.info(`[filestore/local] Saved: ${key}`);
  }

  async get(key: string, localPath: string) {
    const sourcePath = getLocalPathForKey(key);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.copyFile(sourcePath, localPath);
    console.info(`[filestore/local] Retrieved: ${key}`);
  }

  async delete(key: string) {
    const targetPath = getLocalPathForKey(key);

    try {
      await fs.unlink(targetPath);
      console.info(`[filestore/local] Deleted: ${key}`);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  async getDownloadUrl(key: string, filename: string) {
    const url = createLocalDownloadUrl(key, filename);
    console.info(`[filestore/local] Generated download URL for: ${key}`);
    return url;
  }
}
