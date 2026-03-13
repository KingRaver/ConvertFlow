import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cleanupExpiredConversions, recoverStuckProcessingJobs, STALE_PROCESSING_MESSAGE } from "../server/maintenance";
import { OUTPUT_DIR, ensureWorkingDirectories } from "../server/files";
import { MemStorage } from "../server/storage";

const VISITOR_ID = "cf_77777777-7777-4777-8777-777777777777";

test("cleanupExpiredConversions deletes expired rows and their output files", async (t) => {
  ensureWorkingDirectories();

  const storage = new MemStorage();
  const outputFilename = `expired-${Date.now()}.txt`;
  const outputPath = path.join(OUTPUT_DIR, outputFilename);

  fs.writeFileSync(outputPath, "expired output\n", "utf8");
  t.after(() => {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
  });

  const conversion = await storage.createConversion({
    originalName: "sample.txt",
    originalFormat: "txt",
    targetFormat: "docx",
    status: "completed",
    fileSize: 14,
    convertedSize: 14,
    outputFilename,
    resultMessage: "Done",
    visitorId: VISITOR_ID,
    processingStartedAt: new Date(Date.now() - 30_000),
    engineUsed: "docx",
    expiresAt: new Date(Date.now() - 1_000),
  });

  const cleaned = await cleanupExpiredConversions(storage, new Date());

  assert.equal(cleaned, 1);
  assert.equal(await storage.getConversion(conversion.id), undefined);
  assert.equal(fs.existsSync(outputPath), false);
});

test("recoverStuckProcessingJobs fails only stale processing jobs", async () => {
  const storage = new MemStorage();

  const staleConversion = await storage.createConversion({
    originalName: "stale.txt",
    originalFormat: "txt",
    targetFormat: "pdf",
    status: "processing",
    fileSize: 10,
    visitorId: VISITOR_ID,
    processingStartedAt: new Date(Date.now() - 6 * 60 * 1000),
    engineUsed: "pdfkit",
    expiresAt: new Date(Date.now() + 60_000),
  });

  const activeConversion = await storage.createConversion({
    originalName: "active.txt",
    originalFormat: "txt",
    targetFormat: "docx",
    status: "processing",
    fileSize: 10,
    visitorId: VISITOR_ID,
    processingStartedAt: new Date(Date.now() - 60_000),
    engineUsed: "docx",
    expiresAt: new Date(Date.now() + 60_000),
  });

  const recovered = await recoverStuckProcessingJobs(storage, new Date());

  assert.equal(recovered, 1);
  assert.equal((await storage.getConversion(staleConversion.id))?.status, "failed");
  assert.equal(
    (await storage.getConversion(staleConversion.id))?.resultMessage,
    STALE_PROCESSING_MESSAGE,
  );
  assert.equal((await storage.getConversion(activeConversion.id))?.status, "processing");
});
