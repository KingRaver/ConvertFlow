import fs from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import type { Conversion } from "@shared/schema";
import { ConversionError } from "./converters";
import { registry } from "./converters/registry";
import { validateOutputFile } from "./converters/validation";
import { OUTPUT_DIR, safeUnlink } from "./files";
import { storage } from "./storage";

export interface ConversionJobPayload {
  conversionId: number;
  inputPath: string;
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

export async function expireConversionRecord(conversion: Conversion) {
  safeUnlink(
    conversion.outputFilename ? path.join(OUTPUT_DIR, conversion.outputFilename) : null,
  );
  await storage.deleteConversion(conversion.id);
}

export async function expireConversionById(
  { conversionId }: ExpiryJobPayload,
  now = new Date(),
) {
  const conversion = await storage.getConversion(conversionId);

  if (!conversion) {
    return false;
  }

  if (!conversion.expiresAt || conversion.expiresAt > now) {
    return false;
  }

  await expireConversionRecord(conversion);
  return true;
}

export async function processQueuedConversion({
  conversionId,
  inputPath,
  sourceFormat,
  targetFormat,
}: ConversionJobPayload) {
  const conversion = await storage.getConversion(conversionId).catch((error) => {
    safeUnlink(inputPath);
    throw error;
  });

  if (!conversion) {
    safeUnlink(inputPath);
    return;
  }

  if (conversion.expiresAt && conversion.expiresAt.getTime() <= Date.now()) {
    safeUnlink(inputPath);
    await expireConversionRecord(conversion);
    return;
  }

  if (conversion.status === "completed" || conversion.status === "failed") {
    safeUnlink(inputPath);
    return;
  }

  const outputFilename = `${uuidv4()}.${targetFormat}`;
  const outputPath = path.join(OUTPUT_DIR, outputFilename);
  let engineUsed: string | null = conversion.engineUsed ?? null;

  try {
    const adapter = registry.getAdapter(sourceFormat, targetFormat);
    engineUsed = adapter.engineName;

    await storage.updateConversion(conversionId, {
      engineUsed,
      processingStartedAt: new Date(),
      resultMessage: formatProcessingMessage(sourceFormat, targetFormat),
      status: "processing",
    });

    await adapter.convert(inputPath, outputPath);
    await validateOutputFile(outputPath, targetFormat);

    safeUnlink(inputPath);

    const convertedSize = fs.statSync(outputPath).size;
    await storage.updateConversion(conversionId, {
      convertedSize,
      engineUsed,
      outputFilename,
      resultMessage: formatSuccessMessage(sourceFormat, targetFormat),
      status: "completed",
    });
  } catch (error) {
    safeUnlink(inputPath);
    safeUnlink(outputPath);

    await storage.updateConversion(conversionId, {
      convertedSize: null,
      engineUsed,
      outputFilename: null,
      resultMessage: formatFailureMessage(error, sourceFormat, targetFormat),
      status: "failed",
    });
  }
}
