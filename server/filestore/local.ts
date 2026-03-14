import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { FileStore } from "./index";
import { getLogger } from "../observability/logger";
import { resolveLocalFilestoreSigningSecret } from "../runtime-config";

const DOWNLOAD_TTL_SECONDS = 15 * 60;
const filestoreLogger = getLogger({ component: "filestore", driver: "local" });

function getLocalSigningSecret() {
  const secret = resolveLocalFilestoreSigningSecret();

  if (!secret) {
    throw new Error(
      "LOCAL_FILESTORE_SIGNING_SECRET (or SESSION_SECRET) must be set when STORAGE_DRIVER=local.",
    );
  }

  return secret;
}

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
    .createHmac("sha256", getLocalSigningSecret())
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
    filestoreLogger.info({ key }, "Saved file");
  }

  async get(key: string, localPath: string) {
    const sourcePath = getLocalPathForKey(key);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.copyFile(sourcePath, localPath);
    filestoreLogger.info({ key }, "Retrieved file");
  }

  async delete(key: string) {
    const targetPath = getLocalPathForKey(key);

    try {
      await fs.unlink(targetPath);
      filestoreLogger.info({ key }, "Deleted file");
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  async exists(key: string) {
    try {
      await fs.access(getLocalPathForKey(key));
      return true;
    } catch {
      return false;
    }
  }

  async checkHealth() {
    await Promise.all([
      fs.access(path.join(process.cwd(), "uploads"), fsConstants.R_OK | fsConstants.W_OK),
      fs.access(path.join(process.cwd(), "outputs"), fsConstants.R_OK | fsConstants.W_OK),
    ]);
  }

  async getDownloadUrl(key: string, filename: string) {
    const url = createLocalDownloadUrl(key, filename);
    filestoreLogger.info({ key }, "Generated download URL");
    return url;
  }
}
