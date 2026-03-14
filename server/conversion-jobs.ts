import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import type { Conversion, WebhookEventType } from "@shared/schema";
import { ConversionError } from "./converters";
import { registry } from "./converters/registry";
import { validateOutputFile } from "./converters/validation";
import { filestore, getOutputObjectKey } from "./filestore";
import { safeUnlink } from "./files";
import { recordConversionResult } from "./observability/metrics";
import { getLogger } from "./observability/logger";
import { captureException } from "./observability/sentry";
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

interface ProcessQueuedConversionOptions {
  onSettled?: (conversion: Conversion, event: WebhookEventType) => Promise<void>;
}

const conversionLogger = getLogger({ component: "conversion-jobs" });

function getRouteLabel(sourceFormat: string, targetFormat: string) {
  return `${sourceFormat}->${targetFormat}`;
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
    conversionLogger.error({ err: error, key }, "Failed to delete stored object");
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
    conversionLogger.error({ dir, err: error }, "Failed to remove temp workspace");
  }
}

async function notifySettledConversion(
  conversion: Conversion | undefined,
  event: WebhookEventType,
  options?: ProcessQueuedConversionOptions,
) {
  if (!conversion || !options?.onSettled) {
    return;
  }

  try {
    await options.onSettled(conversion, event);
  } catch (error) {
    conversionLogger.error({ conversionId: conversion.id, err: error, event }, "Failed to enqueue webhooks");
  }
}

async function syncBatchIfNeeded(batchId: number | null | undefined) {
  if (!batchId) {
    return;
  }

  try {
    await storage.syncBatch(batchId);
  } catch (error) {
    conversionLogger.error({ batchId, err: error }, "Failed to sync batch");
  }
}

export async function expireConversionRecord(
  conversion: Conversion,
  activeStorage: IStorage = storage,
) {
  const batchId = conversion.batchId;
  await safeDeleteStoredFile(conversion.inputKey);
  await safeDeleteStoredFile(
    conversion.outputFilename ? getOutputObjectKey(conversion.outputFilename) : null,
  );
  await activeStorage.deleteConversion(conversion.id);
  if (batchId) {
    await activeStorage.syncBatch(batchId);
  }
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
  inputKey: payloadInputKey,
  sourceFormat,
  targetFormat,
}: ConversionJobPayload, options?: ProcessQueuedConversionOptions) {
  const route = getRouteLabel(sourceFormat, targetFormat);
  const conversion = await storage.getConversion(conversionId).catch(async (error) => {
    await safeDeleteStoredFile(payloadInputKey);
    throw error;
  });

  if (!conversion) {
    await safeDeleteStoredFile(payloadInputKey);
    return;
  }

  const inputKey = conversion.inputKey ?? payloadInputKey;

  if (conversion.expiresAt && conversion.expiresAt.getTime() <= Date.now()) {
    await safeDeleteStoredFile(inputKey);
    await expireConversionRecord(conversion);
    return;
  }

  if (conversion.status === "completed" || conversion.status === "failed") {
    return;
  }

  if (!inputKey) {
    const failedConversion = await storage.updateConversion(conversionId, {
      resultMessage: "Failed to convert: original input file is unavailable.",
      status: "failed",
    });
    recordConversionResult({
      durationMs: 0,
      inputBytes: conversion.fileSize,
      route,
      status: "failed",
    });
    conversionLogger.error({
      conversionId,
      fileSize: conversion.fileSize,
      sourceFormat,
      status: "failed",
      targetFormat,
      userId: conversion.userId,
      visitorId: conversion.visitorId,
    }, "Conversion failed because the input file is unavailable");
    await syncBatchIfNeeded(conversion.batchId);
    await notifySettledConversion(failedConversion, "conversion.failed", options);
    return;
  }

  const outputFilename = conversion.outputFilename ?? `${uuidv4()}.${targetFormat}`;
  const outputKey = getOutputObjectKey(outputFilename);
  let engineUsed: string | null = conversion.engineUsed ?? null;
  let workspace: Awaited<ReturnType<typeof createJobWorkspace>> | null = null;
  const startedAt = Date.now();

  try {
    const adapter = registry.getAdapter(sourceFormat, targetFormat);
    engineUsed = adapter.engineName;
    workspace = await createJobWorkspace(sourceFormat, targetFormat);

    conversionLogger.info({
      conversionId,
      engineUsed,
      fileSize: conversion.fileSize,
      sourceFormat,
      status: "processing",
      targetFormat,
      userId: conversion.userId,
      visitorId: conversion.visitorId,
    }, "Conversion started");

    await storage.updateConversion(conversionId, {
      engineUsed,
      processingStartedAt: new Date(),
      resultMessage: formatProcessingMessage(sourceFormat, targetFormat),
      status: "processing",
    });
    await syncBatchIfNeeded(conversion.batchId);

    await filestore.get(inputKey, workspace.inputPath);
    await adapter.convert(workspace.inputPath, workspace.outputPath, conversion.options ?? undefined);
    await validateOutputFile(workspace.outputPath, targetFormat);
    await filestore.save(workspace.outputPath, outputKey);

    const convertedSize = fs.statSync(workspace.outputPath).size;
    const durationMs = Date.now() - startedAt;
    const completedConversion = await storage.updateConversion(conversionId, {
      convertedSize,
      engineUsed,
      outputFilename,
      resultMessage: formatSuccessMessage(sourceFormat, targetFormat),
      status: "completed",
    });

    recordConversionResult({
      durationMs,
      inputBytes: conversion.fileSize,
      outputBytes: convertedSize,
      route,
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
        conversionLogger.error({ conversionId, err: usageError }, "Failed to record usage");
      }
    }

    conversionLogger.info({
      conversionId,
      durationMs,
      engineUsed,
      fileSize: conversion.fileSize,
      sourceFormat,
      status: "completed",
      targetFormat,
      userId: conversion.userId,
      visitorId: conversion.visitorId,
    }, "Conversion completed");

    await syncBatchIfNeeded(conversion.batchId);
    await notifySettledConversion(completedConversion, "conversion.completed", options);
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    await safeDeleteStoredFile(outputKey);

    const failedConversion = await storage.updateConversion(conversionId, {
      convertedSize: null,
      engineUsed,
      outputFilename: null,
      resultMessage: formatFailureMessage(error, sourceFormat, targetFormat),
      status: "failed",
    });

    recordConversionResult({
      durationMs,
      inputBytes: conversion.fileSize,
      route,
      status: "failed",
    });

    conversionLogger.error({
      conversionId,
      durationMs,
      engineUsed,
      err: error,
      fileSize: conversion.fileSize,
      sourceFormat,
      status: "failed",
      targetFormat,
      userId: conversion.userId,
      visitorId: conversion.visitorId,
    }, "Conversion failed");
    captureException(error, {
      contexts: {
        conversion: {
          conversionId,
          durationMs,
          engineUsed,
          fileSize: conversion.fileSize,
          sourceFormat,
          status: "failed",
          targetFormat,
          userId: conversion.userId,
          visitorId: conversion.visitorId,
        },
      },
      extras: {
        route,
      },
      tags: {
        component: "conversion",
        route,
      },
    });

    await syncBatchIfNeeded(conversion.batchId);
    await notifySettledConversion(failedConversion, "conversion.failed", options);
  } finally {
    safeUnlink(workspace?.inputPath);
    safeUnlink(workspace?.outputPath);
    await cleanupWorkspace(workspace?.dir ?? null);
  }
}
