import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import type { Conversion } from "@shared/schema";
import { ConversionError } from "./converters";
import { registry } from "./converters/registry";
import { validateOutputFile } from "./converters/validation";
import { filestore, getOutputObjectKey } from "./filestore";
import { safeUnlink } from "./files";
import type { IStorage } from "./storage";
import { storage } from "./storage";

export interface ConversionJobPayload {
  conversionId: number;
  inputKey: string;
  sourceFormat: string;
  targetFormat: string;
}

export interface ExpiryJobPayload {
  conversionId: number;
}

export function formatQueuedMessage(sourceFormat: string, targetFormat: string) {
  return `Queued .${sourceFormat} to .${targetFormat} conversion.`;
}

export function formatProcessingMessage(sourceFormat: string, targetFormat: string) {
  return `Converting .${sourceFormat} to .${targetFormat}.`;
}

function formatSuccessMessage(sourceFormat: string, targetFormat: string) {
  return `Converted .${sourceFormat} to .${targetFormat}.`;
}

function formatFailureMessage(
  error: unknown,
  sourceFormat: string,
  targetFormat: string,
) {
  if (error instanceof ConversionError) {
    return error.message;
  }

  if (error instanceof Error && error.message) {
    return `Failed to convert .${sourceFormat} to .${targetFormat}: ${error.message}`;
  }

  return `Failed to convert .${sourceFormat} to .${targetFormat}.`;
}

async function safeDeleteStoredFile(key: string | null | undefined) {
  if (!key) {
    return;
  }

  try {
    await filestore.delete(key);
  } catch (error) {
    console.error(`Failed to delete stored object: ${key}`, error);
  }
}

async function createJobWorkspace(sourceFormat: string, targetFormat: string) {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "convertflow-job-"));

  return {
    dir,
    inputPath: path.join(dir, `input.${sourceFormat}`),
    outputPath: path.join(dir, `output.${targetFormat}`),
  };
}

async function cleanupWorkspace(dir: string | null) {
  if (!dir) {
    return;
  }

  try {
    await fsPromises.rm(dir, { force: true, recursive: true });
  } catch (error) {
    console.error(`Failed to remove temp workspace: ${dir}`, error);
  }
}

export async function expireConversionRecord(
  conversion: Conversion,
  activeStorage: IStorage = storage,
) {
  await safeDeleteStoredFile(
    conversion.outputFilename ? getOutputObjectKey(conversion.outputFilename) : null,
  );
  await activeStorage.deleteConversion(conversion.id);
}

export async function expireConversionById(
  { conversionId }: ExpiryJobPayload,
  now = new Date(),
  activeStorage: IStorage = storage,
) {
  const conversion = await activeStorage.getConversion(conversionId);

  if (!conversion) {
    return false;
  }

  if (!conversion.expiresAt || conversion.expiresAt > now) {
    return false;
  }

  await expireConversionRecord(conversion, activeStorage);
  return true;
}

export async function processQueuedConversion({
  conversionId,
  inputKey,
  sourceFormat,
  targetFormat,
}: ConversionJobPayload) {
  const conversion = await storage.getConversion(conversionId).catch(async (error) => {
    await safeDeleteStoredFile(inputKey);
    throw error;
  });

  if (!conversion) {
    await safeDeleteStoredFile(inputKey);
    return;
  }

  if (conversion.expiresAt && conversion.expiresAt.getTime() <= Date.now()) {
    await safeDeleteStoredFile(inputKey);
    await expireConversionRecord(conversion);
    return;
  }

  if (conversion.status === "completed" || conversion.status === "failed") {
    await safeDeleteStoredFile(inputKey);
    return;
  }

  const outputFilename = conversion.outputFilename ?? `${uuidv4()}.${targetFormat}`;
  const outputKey = getOutputObjectKey(outputFilename);
  let engineUsed: string | null = conversion.engineUsed ?? null;
  let workspace: Awaited<ReturnType<typeof createJobWorkspace>> | null = null;

  try {
    const adapter = registry.getAdapter(sourceFormat, targetFormat);
    engineUsed = adapter.engineName;
    workspace = await createJobWorkspace(sourceFormat, targetFormat);

    await storage.updateConversion(conversionId, {
      engineUsed,
      processingStartedAt: new Date(),
      resultMessage: formatProcessingMessage(sourceFormat, targetFormat),
      status: "processing",
    });

    await filestore.get(inputKey, workspace.inputPath);
    await adapter.convert(workspace.inputPath, workspace.outputPath);
    await validateOutputFile(workspace.outputPath, targetFormat);
    await filestore.save(workspace.outputPath, outputKey);
    await safeDeleteStoredFile(inputKey);

    const convertedSize = fs.statSync(workspace.outputPath).size;
    await storage.updateConversion(conversionId, {
      convertedSize,
      engineUsed,
      outputFilename,
      resultMessage: formatSuccessMessage(sourceFormat, targetFormat),
      status: "completed",
    });

    if (conversion.userId !== null) {
      try {
        await storage.createUsageEvent({
          eventType: "conversion",
          fileSize: conversion.fileSize,
          format: `${sourceFormat}->${targetFormat}`,
          userId: conversion.userId,
        });
      } catch (usageError) {
        console.error(`Failed to record usage for conversion ${conversionId}`, usageError);
      }
    }
  } catch (error) {
    await safeDeleteStoredFile(inputKey);
    await safeDeleteStoredFile(outputKey);

    await storage.updateConversion(conversionId, {
      convertedSize: null,
      engineUsed,
      outputFilename: null,
      resultMessage: formatFailureMessage(error, sourceFormat, targetFormat),
      status: "failed",
    });
  } finally {
    safeUnlink(workspace?.inputPath);
    safeUnlink(workspace?.outputPath);
    await cleanupWorkspace(workspace?.dir ?? null);
  }
}
