import { expireConversionRecord } from "./conversion-jobs";
import type { IStorage } from "./storage";
import { storage } from "./storage";
import {
  UPLOAD_TMP_DIR,
  ensureWorkingDirectories,
  sweepDirectory,
} from "./files";

const STALE_PROCESSING_WINDOW_MS = 5 * 60 * 1000;

export const STALE_PROCESSING_MESSAGE = "Server restarted during processing.";

export async function cleanupExpiredConversions(
  activeStorage: IStorage = storage,
  now = new Date(),
) {
  const expiredConversions = await activeStorage.getExpiredConversions(now);

  for (const conversion of expiredConversions) {
    await expireConversionRecord(conversion, activeStorage);
  }

  return expiredConversions.length;
}

export async function recoverStuckProcessingJobs(
  activeStorage: IStorage = storage,
  now = new Date(),
) {
  const cutoff = new Date(now.getTime() - STALE_PROCESSING_WINDOW_MS);
  return activeStorage.failStaleProcessingJobs(cutoff, STALE_PROCESSING_MESSAGE);
}

async function runCleanupPass(activeStorage: IStorage = storage, now = new Date()) {
  const cleaned = await cleanupExpiredConversions(activeStorage, now);
  sweepDirectory(UPLOAD_TMP_DIR);
  return cleaned;
}

export async function runStartupMaintenance(activeStorage: IStorage = storage, now = new Date()) {
  ensureWorkingDirectories();

  const recovered = await recoverStuckProcessingJobs(activeStorage, now);
  const cleaned = await runCleanupPass(activeStorage, now);

  return { cleaned, recovered };
}
