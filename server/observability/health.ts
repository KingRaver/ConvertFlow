import { isBillingConfigured } from "../billing";
import { isLegacyDocConverterAvailable } from "../converters/runtime";
import { filestore } from "../filestore";
import { db, pool } from "../db";
import { getQueueHealthStatus, getQueueRuntimeKind } from "../queue";
import { getStorageRuntimeKind } from "../storage";
import { getLogger } from "./logger";

const healthLogger = getLogger({ component: "health" });

export type HealthStatus = "error" | "ok";

export async function getHealthStatus() {
  const billingConfigured = isBillingConfigured();
  const legacyDocConverterAvailable = isLegacyDocConverterAvailable();
  const [dbStatus, queueStatus, storageStatus] = await Promise.all([
    checkDatabaseHealth(),
    checkQueueHealth(),
    checkStorageHealth(),
  ]);

  const status: HealthStatus = dbStatus === "ok" && queueStatus === "ok" && storageStatus === "ok"
    ? "ok"
    : "error";

  return {
    capabilities: {
      billingConfigured,
      legacyDocConverterAvailable,
    },
    db: dbStatus,
    queue: queueStatus,
    runtime: {
      filestore: filestore.driver,
      queue: getQueueRuntimeKind(),
      storage: getStorageRuntimeKind(),
    },
    status,
    storage: storageStatus,
  };
}

async function checkDatabaseHealth(): Promise<HealthStatus> {
  if (!db || !pool) {
    return "ok";
  }

  try {
    await pool.query("select 1");
    return "ok";
  } catch (error) {
    healthLogger.warn({ err: error }, "Database health check failed");
    return "error";
  }
}

async function checkQueueHealth(): Promise<HealthStatus> {
  try {
    const healthy = await getQueueHealthStatus();
    return healthy ? "ok" : "error";
  } catch (error) {
    healthLogger.warn({ err: error }, "Queue health check failed");
    return "error";
  }
}

async function checkStorageHealth(): Promise<HealthStatus> {
  try {
    await filestore.checkHealth();
    return "ok";
  } catch (error) {
    healthLogger.warn({ err: error, storageDriver: filestore.driver }, "Storage health check failed");
    return "error";
  }
}
