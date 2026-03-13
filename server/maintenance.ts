import path from "node:path";
import type { IStorage } from "./storage";
import { storage } from "./storage";
import {
  OUTPUT_DIR,
  UPLOAD_DIR,
  ensureWorkingDirectories,
  safeUnlink,
  sweepDirectory,
} from "./files";

const EXPIRED_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const STALE_PROCESSING_WINDOW_MS = 5 * 60 * 1000;

export const STALE_PROCESSING_MESSAGE = "Server restarted during processing.";

export async function cleanupExpiredConversions(
  activeStorage: IStorage = storage,
  now = new Date(),
) {
  const expiredConversions = await activeStorage.getExpiredConversions(now);

  for (const conversion of expiredConversions) {
    const outputPath = conversion.outputFilename
      ? path.join(OUTPUT_DIR, conversion.outputFilename)
      : null;

    safeUnlink(outputPath);
    await activeStorage.deleteConversion(conversion.id);
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
  sweepDirectory(UPLOAD_DIR);
  sweepDirectory(OUTPUT_DIR);
  return cleaned;
}

export async function runStartupMaintenance(activeStorage: IStorage = storage, now = new Date()) {
  ensureWorkingDirectories();

  const recovered = await recoverStuckProcessingJobs(activeStorage, now);
  const cleaned = await runCleanupPass(activeStorage, now);

  return { cleaned, recovered };
}

export function startExpiredConversionCleanup(options?: {
  onError?: (error: unknown) => void;
  storage?: IStorage;
}) {
  const activeStorage = options?.storage ?? storage;
  const onError = options?.onError ?? ((error: unknown) => console.error(error));

  ensureWorkingDirectories();

  let running = false;
  const run = async () => {
    if (running) {
      return;
    }

    running = true;
    try {
      await runCleanupPass(activeStorage);
    } catch (error) {
      onError(error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void run();
  }, EXPIRED_SWEEP_INTERVAL_MS);

  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
