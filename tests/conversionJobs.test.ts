import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import type { InsertConversion } from "../shared/schema";
import {
  expireConversionById,
  expireConversionRecord,
  processQueuedConversion,
} from "../server/conversion-jobs";
import { OUTPUT_DIR, ensureWorkingDirectories } from "../server/files";
import { getUploadObjectKey } from "../server/filestore";
import { storage } from "../server/storage";

const VISITOR_ID = "cf_88888888-8888-4888-8888-888888888888";
const FIXTURE_TXT = path.join(process.cwd(), "tests/fixtures/sample.txt");

function getLocalObjectPath(key: string) {
  return path.join(process.cwd(), key);
}

function writeUploadObject(content: string | Buffer, ext: string) {
  ensureWorkingDirectories();
  const inputKey = getUploadObjectKey(`${uuidv4()}.${ext}`);
  const inputPath = getLocalObjectPath(inputKey);
  fs.writeFileSync(inputPath, content);
  return { inputKey, inputPath };
}

async function makeConversion(overrides: Partial<InsertConversion> = {}) {
  return storage.createConversion({
    originalName: "sample.txt",
    originalFormat: "txt",
    targetFormat: "docx",
    status: "pending",
    fileSize: 100,
    convertedSize: null,
    outputFilename: null,
    processingStartedAt: null,
    engineUsed: null,
    resultMessage: null,
    visitorId: VISITOR_ID,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// processQueuedConversion
// ──────────────────────────────────────────────────────────────────────────────

test("processQueuedConversion converts txt→docx and marks the job completed", async (t) => {
  const { inputKey, inputPath } = writeUploadObject(fs.readFileSync(FIXTURE_TXT), "txt");
  const conversion = await makeConversion();

  await processQueuedConversion({
    conversionId: conversion.id,
    inputKey,
    sourceFormat: "txt",
    targetFormat: "docx",
  });

  const result = await storage.getConversion(conversion.id);
  assert.ok(result, "record should still exist");
  assert.equal(result.status, "completed");
  assert.ok(result.outputFilename, "outputFilename should be set");
  assert.ok(result.convertedSize && result.convertedSize > 0, "convertedSize should be positive");
  assert.equal(result.engineUsed, "docx");
  assert.equal(result.processingStartedAt !== null, true, "processingStartedAt should be set");

  const outputPath = path.join(OUTPUT_DIR, result.outputFilename);
  assert.ok(fs.existsSync(outputPath), "output file should exist on disk");
  assert.equal(fs.existsSync(inputPath), false, "input file should be deleted after conversion");

  t.after(() => {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  });
});

test("processQueuedConversion marks the job failed and cleans up when input file is missing", async () => {
  const inputKey = getUploadObjectKey(`${uuidv4()}.txt`); // not created
  const inputPath = getLocalObjectPath(inputKey);
  const conversion = await makeConversion();

  await processQueuedConversion({
    conversionId: conversion.id,
    inputKey,
    sourceFormat: "txt",
    targetFormat: "docx",
  });

  const result = await storage.getConversion(conversion.id);
  assert.ok(result, "record should still exist");
  assert.equal(result.status, "failed");
  assert.ok(result.resultMessage, "resultMessage should be set");
  assert.equal(result.outputFilename, null, "outputFilename should remain null");
  assert.equal(fs.existsSync(inputPath), false, "input path should not exist");
});

test("processQueuedConversion cleans up input file when the conversion record is missing", async () => {
  const { inputKey, inputPath } = writeUploadObject("hello\n", "txt");

  await processQueuedConversion({
    conversionId: 9_000_001, // record does not exist
    inputKey,
    sourceFormat: "txt",
    targetFormat: "docx",
  });

  assert.equal(fs.existsSync(inputPath), false, "input file should be cleaned up");
});

test("processQueuedConversion cleans up and expires a conversion that has already passed its TTL", async () => {
  const { inputKey, inputPath } = writeUploadObject("hello\n", "txt");
  const conversion = await makeConversion({
    expiresAt: new Date(Date.now() - 1_000), // already expired
  });

  await processQueuedConversion({
    conversionId: conversion.id,
    inputKey,
    sourceFormat: "txt",
    targetFormat: "docx",
  });

  assert.equal(fs.existsSync(inputPath), false, "input file should be cleaned up");
  assert.equal(
    await storage.getConversion(conversion.id),
    undefined,
    "expired record should be deleted from storage",
  );
});

test("processQueuedConversion is a no-op for already-completed jobs", async () => {
  const { inputKey, inputPath } = writeUploadObject("hello\n", "txt");
  const conversion = await makeConversion({ status: "completed" });

  await processQueuedConversion({
    conversionId: conversion.id,
    inputKey,
    sourceFormat: "txt",
    targetFormat: "docx",
  });

  assert.equal(fs.existsSync(inputPath), false, "input file should be cleaned up");
  const result = await storage.getConversion(conversion.id);
  assert.ok(result);
  assert.equal(result.status, "completed", "status must not be changed");
});

test("processQueuedConversion is a no-op for already-failed jobs", async () => {
  const { inputKey, inputPath } = writeUploadObject("hello\n", "txt");
  const conversion = await makeConversion({ status: "failed" });

  await processQueuedConversion({
    conversionId: conversion.id,
    inputKey,
    sourceFormat: "txt",
    targetFormat: "docx",
  });

  assert.equal(fs.existsSync(inputPath), false, "input file should be cleaned up");
  const result = await storage.getConversion(conversion.id);
  assert.ok(result);
  assert.equal(result.status, "failed", "status must not be changed");
});

// ──────────────────────────────────────────────────────────────────────────────
// expireConversionRecord
// ──────────────────────────────────────────────────────────────────────────────

test("expireConversionRecord deletes the record and its output file", async (t) => {
  ensureWorkingDirectories();
  const outputFilename = `${uuidv4()}.docx`;
  const outputPath = path.join(OUTPUT_DIR, outputFilename);
  fs.writeFileSync(outputPath, "fake output");
  t.after(() => {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  });

  const conversion = await makeConversion({
    status: "completed",
    outputFilename,
    expiresAt: new Date(Date.now() - 1_000),
  });

  await expireConversionRecord(conversion);

  assert.equal(fs.existsSync(outputPath), false, "output file should be deleted");
  assert.equal(
    await storage.getConversion(conversion.id),
    undefined,
    "record should be deleted from storage",
  );
});

test("expireConversionRecord handles a record with no output file", async () => {
  const conversion = await makeConversion({
    status: "failed",
    outputFilename: null,
    expiresAt: new Date(Date.now() - 1_000),
  });

  // should not throw when outputFilename is null
  await expireConversionRecord(conversion);

  assert.equal(
    await storage.getConversion(conversion.id),
    undefined,
    "record should be deleted from storage",
  );
});

// ──────────────────────────────────────────────────────────────────────────────
// expireConversionById
// ──────────────────────────────────────────────────────────────────────────────

test("expireConversionById deletes an expired record and its output file", async (t) => {
  ensureWorkingDirectories();
  const outputFilename = `${uuidv4()}.docx`;
  const outputPath = path.join(OUTPUT_DIR, outputFilename);
  fs.writeFileSync(outputPath, "fake output");
  t.after(() => {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  });

  const conversion = await makeConversion({
    status: "completed",
    outputFilename,
    expiresAt: new Date(Date.now() - 1_000),
  });

  const result = await expireConversionById({ conversionId: conversion.id });

  assert.equal(result, true);
  assert.equal(fs.existsSync(outputPath), false, "output file should be deleted");
  assert.equal(
    await storage.getConversion(conversion.id),
    undefined,
    "record should be deleted from storage",
  );
});

test("expireConversionById is a no-op when the conversion has not yet expired", async () => {
  const conversion = await makeConversion({
    expiresAt: new Date(Date.now() + 60_000),
  });

  const result = await expireConversionById({ conversionId: conversion.id });

  assert.equal(result, false);
  assert.ok(
    await storage.getConversion(conversion.id),
    "record should still exist",
  );
});

test("expireConversionById is a no-op when the conversion does not exist", async () => {
  const result = await expireConversionById({ conversionId: 9_000_002 });
  assert.equal(result, false);
});
