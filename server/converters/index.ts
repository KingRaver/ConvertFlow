export type ConversionOptions = Record<string, unknown> | null | undefined;

export interface ConverterAdapter {
  convert(inputPath: string, outputPath: string, options?: ConversionOptions): Promise<void>;
}

export type ConverterFamily = "image" | "document" | "data" | "audio" | "video";

export interface RegisteredConverterAdapter extends ConverterAdapter {
  readonly family: ConverterFamily;
  readonly sourceFormat: string;
  readonly targetFormat: string;
  readonly engineName: string;
}

export type ConversionErrorCode =
  | "unsupported_route"
  | "missing_runtime"
  | "conversion_failed"
  | "output_validation_failed"
  | "timeout";

interface ConversionErrorOptions extends ErrorOptions {
  details?: string;
}

export class ConversionError extends Error {
  readonly code: ConversionErrorCode;
  readonly details?: string;

  constructor(
    message: string,
    code: ConversionErrorCode = "conversion_failed",
    options?: ConversionErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.details = options?.details;
  }
}

export class MissingToolError extends ConversionError {
  constructor(message: string, options?: ConversionErrorOptions) {
    super(message, "missing_runtime", options);
  }
}

export class ConversionTimeoutError extends ConversionError {
  constructor(message: string, options?: ConversionErrorOptions) {
    super(message, "timeout", options);
  }
}

export class OutputValidationError extends ConversionError {
  constructor(message: string, options?: ConversionErrorOptions) {
    super(message, "output_validation_failed", options);
  }
}

export function normalizeFormat(format: string) {
  const normalized = format.trim().toLowerCase();
  return normalized === "jpeg" ? "jpg" : normalized;
}

export function routeKey(sourceFormat: string, targetFormat: string) {
  return `${normalizeFormat(sourceFormat)}->${normalizeFormat(targetFormat)}`;
}
