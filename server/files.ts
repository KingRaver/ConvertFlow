import fs from "node:fs";
import path from "node:path";

export const UPLOAD_DIR = path.join(process.cwd(), "uploads");
export const OUTPUT_DIR = path.join(process.cwd(), "outputs");
export const FILE_TTL_MS = 30 * 60 * 1000;

export function ensureWorkingDirectories() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
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
      console.error(`Failed to remove file: ${filePath}`, error);
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
      console.error(`Failed to inspect file during sweep: ${entryPath}`, error);
    }
  }
}
