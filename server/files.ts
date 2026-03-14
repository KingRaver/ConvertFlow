import fs from "node:fs";
import path from "node:path";
import { getLogger } from "./observability/logger";

export const UPLOAD_DIR = path.join(process.cwd(), "uploads");
export const UPLOAD_TMP_DIR = path.join(UPLOAD_DIR, "_tmp");
export const OUTPUT_DIR = path.join(process.cwd(), "outputs");
export const FILE_TTL_MS = 30 * 60 * 1000;
const fileLogger = getLogger({ component: "files" });

export function ensureWorkingDirectories() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

export function safeUnlink(filePath: string | null | undefined) {
  if (!filePath) {
    return;
  }

  try {
    fs.unlinkSync(filePath);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      fileLogger.error({ err: error, filePath }, "Failed to remove file");
    }
  }
}

export function sweepDirectory(dir: string, ttlMs = FILE_TTL_MS) {
  if (!fs.existsSync(dir)) {
    return;
  }

  const now = Date.now();
  for (const entry of fs.readdirSync(dir)) {
    const entryPath = path.join(dir, entry);

    try {
      const stat = fs.statSync(entryPath);
      if (!stat.isFile()) {
        continue;
      }

      if (now - stat.mtimeMs > ttlMs) {
        safeUnlink(entryPath);
      }
    } catch (error) {
      fileLogger.error({ dir, entryPath, err: error }, "Failed to inspect file during sweep");
    }
  }
}
