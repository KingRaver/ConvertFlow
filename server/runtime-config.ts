import type { FileStore } from "./filestore";

export type StorageRuntimeKind = "memory" | "postgres";
export type QueueRuntimeKind = "memory" | "pg-boss";

export interface RuntimeConfig {
  allowMemoryStorage: boolean;
  databaseConfigured: boolean;
  filestoreDriver: FileStore["driver"];
  queueRuntime: QueueRuntimeKind;
  storageRuntime: StorageRuntimeKind;
}

function parseBooleanFlag(value: string | undefined) {
  return value?.trim().toLowerCase() === "true";
}

function getStorageDriver(env: NodeJS.ProcessEnv): FileStore["driver"] {
  return env.STORAGE_DRIVER?.trim().toLowerCase() === "s3" ? "s3" : "local";
}

export function resolveLocalFilestoreSigningSecret(env: NodeJS.ProcessEnv = process.env) {
  return env.LOCAL_FILESTORE_SIGNING_SECRET?.trim()
    ?? env.SESSION_SECRET?.trim()
    ?? null;
}

export function resolveRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const databaseConfigured = Boolean(env.DATABASE_URL?.trim());
  const allowMemoryStorage = parseBooleanFlag(env.ALLOW_MEMORY_STORAGE);

  return {
    allowMemoryStorage,
    databaseConfigured,
    filestoreDriver: getStorageDriver(env),
    queueRuntime: databaseConfigured ? "pg-boss" : "memory",
    storageRuntime: databaseConfigured ? "postgres" : "memory",
  };
}

export function validateRuntimeConfig(
  target: "api" | "worker" = "api",
  env: NodeJS.ProcessEnv = process.env,
) {
  const config = resolveRuntimeConfig(env);
  const errors: string[] = [];

  if (!config.databaseConfigured && !config.allowMemoryStorage) {
    errors.push("DATABASE_URL is required unless ALLOW_MEMORY_STORAGE=true is set.");
  }

  if (target === "worker" && config.queueRuntime === "memory") {
    errors.push("DATABASE_URL is required to run the standalone queue worker.");
  }

  if (
    config.filestoreDriver === "local"
    && !resolveLocalFilestoreSigningSecret(env)
  ) {
    errors.push("LOCAL_FILESTORE_SIGNING_SECRET (or SESSION_SECRET) must be set when STORAGE_DRIVER=local.");
  }

  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }

  return config;
}
