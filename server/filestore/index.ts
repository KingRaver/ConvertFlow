import path from "node:path";
import { LocalFileStore } from "./local";
import { S3FileStore } from "./s3";

export interface FileStore {
  readonly driver: "local" | "s3";
  save(localPath: string, key: string): Promise<void>;
  get(key: string, localPath: string): Promise<void>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  getDownloadUrl(key: string, filename: string): Promise<string>;
}

function getStorageDriver() {
  const configured = process.env.STORAGE_DRIVER?.trim().toLowerCase();

  if (configured === "s3") {
    return "s3";
  }

  return "local";
}

export function getUploadObjectKey(filename: string) {
  return `uploads/${filename}`;
}

export function getOutputObjectKey(filename: string) {
  return `outputs/${filename}`;
}

export function getDownloadFilename(originalName: string, targetFormat: string) {
  const parsed = path.parse(path.basename(originalName));
  const baseName = parsed.name || "download";
  return `${baseName}.${targetFormat}`;
}

export const storageDriver = getStorageDriver();
export const filestore: FileStore = storageDriver === "s3"
  ? new S3FileStore()
  : new LocalFileStore();

console.info(`[filestore] Storage driver: ${storageDriver}`);
