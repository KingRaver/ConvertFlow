import { expireConversionRecord } from "./conversion-jobs";
import type { IStorage } from "./storage";
import { getStorage } from "./storage";
import {
  UPLOAD_TMP_DIR,
  ensureWorkingDirectories,
  sweepDirectory,
} from "./files";

const STALE_PROCESSING_WINDOW_MS = 5 * 60 * 1000;

export const STALE_PROCESSING_MESSAGE = "Server restarted during processing.";

export async function cleanupExpiredConversions(
  activeStorage: IStorage = getStorage(),
  now = new Date(),
) {
  const expiredConversions = await activeStorage.getExpiredConversions(now);

  for (const conversion of expiredConversions) {
    await expireConversionRecord(conversion, activeStorage);
  }

  return expiredConversions.length;
}

export async function cleanupExpiredIdempotencyKeys(
  activeStorage: IStorage = getStorage(),
  now = new Date(),
) {
  return activeStorage.deleteExpiredIdempotencyKeys(now);
}

export async function recoverStuckProcessingJobs(
  activeStorage: IStorage = getStorage(),
  now = new Date(),
) {
  const cutoff = new Date(now.getTime() - STALE_PROCESSING_WINDOW_MS);
  return activeStorage.failStaleProcessingJobs(cutoff, STALE_PROCESSING_MESSAGE);
}

async function runCleanupPass(activeStorage: IStorage = getStorage(), now = new Date()) {
  const cleaned = await cleanupExpiredConversions(activeStorage, now);
  const idempotencyCleaned = await cleanupExpiredIdempotencyKeys(activeStorage, now);
  sweepDirectory(UPLOAD_TMP_DIR);
  return { cleaned, idempotencyCleaned };
}

export async function runStartupMaintenance(activeStorage: IStorage = getStorage(), now = new Date()) {
  ensureWorkingDirectories();

  const recovered = await recoverStuckProcessingJobs(activeStorage, now);
  const { cleaned, idempotencyCleaned } = await runCleanupPass(activeStorage, now);

  return { cleaned, idempotencyCleaned, recovered };
}
