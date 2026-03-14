import type { Express, NextFunction, Request, Response } from "express";
import type { Server } from "http";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import multer from "multer";
import path from "path";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import {
  type Batch,
  CONVERSION_STATUSES,
  type Conversion,
  type ConversionStatus,
  getConversionOptionsSchema,
  SUPPORTED_CONVERSIONS,
  SUPPORTED_FORMATS,
  type UserPlan,
  WEBHOOK_EVENT_TYPES,
} from "@shared/schema";
import { VISITOR_ID_HEADER, isValidVisitorId } from "@shared/visitor";
import {
  createApiKeyToken,
  createSessionExpiry,
  createSessionToken,
  hashSecret,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  normalizeEmail,
  verifyPassword,
} from "./auth";
import { expireConversionRecord, formatQueuedMessage } from "./conversion-jobs";
import {
  UPLOAD_TMP_DIR,
  ensureWorkingDirectories,
  safeUnlink,
} from "./files";
import {
  filestore,
  getDownloadFilename,
  getOutputObjectKey,
  getUploadObjectKey,
} from "./filestore";
import {
  createBillingCheckoutSession,
  createBillingPortalSession,
  constructStripeWebhookEvent,
  isBillingConfigured,
  syncStripeBillingEvent,
} from "./billing";
import { getLocalPathFromDownloadKey, parseLocalDownloadParams } from "./filestore/local";
import {
  getDailyUsageExceededMessage,
  getEffectivePlan,
  getFileSizeExceededMessage,
  getPlanLimits,
  getPlanRank,
  getPlanRetentionDeadline,
  getStartOfCurrentUtcDay,
} from "./limits";
import { optionalApiAuth, requireAuth } from "./middleware/auth";
import { createRateLimiter } from "./middleware/rateLimit";
import { getHealthStatus } from "./observability/health";
import { getRequestLogger, getLogger, requestLogger } from "./observability/logger";
import { getMetricsContentType, renderMetrics, setQueueMetrics } from "./observability/metrics";
import { requireMonitoringAccess } from "./observability/monitoring";
import { captureException } from "./observability/sentry";
import {
  enqueueConversionJob,
  getQueueMetricSamples,
  scheduleConversionExpiryJob,
  startQueueServerRuntime,
} from "./queue";
import { storage } from "./storage";
import { createWebhookSecret, serializeWebhook } from "./webhooks";
import { createZipArchive } from "./zip";

const authCredentialsSchema = z.object({
  email: z.string().trim().email("A valid email address is required.").transform(normalizeEmail),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`),
});

const historyQuerySchema = z.object({
  format: z
    .string()
    .trim()
    .toLowerCase()
    .optional()
    .refine((value) => value === undefined || SUPPORTED_FORMATS.includes(value), {
      message: "Format filter must use a supported file format.",
    }),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  page: z.coerce.number().int().min(1).default(1),
  status: z.enum(CONVERSION_STATUSES).optional(),
});

const BILLING_CHECKOUT_PLANS = ["pro", "business"] as const;
const billingCheckoutSchema = z.object({
  plan: z.enum(BILLING_CHECKOUT_PLANS),
});

const apiKeyCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "API key name is required.")
    .max(100, "API key name must be 100 characters or fewer."),
});

const presetCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Preset name is required.")
    .max(100, "Preset name must be 100 characters or fewer."),
  options: z.record(z.unknown()).optional().default({}),
  sourceFormat: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Source format is required."),
  targetFormat: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Target format is required."),
});

function isPrivateUrl(urlString: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(urlString).hostname.toLowerCase();
  } catch {
    return false;
  }

  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "::1" || hostname === "[::1]") return true;

  const parts = hostname.split(".").map(Number);
  if (parts.length === 4 && parts.every((n) => !Number.isNaN(n) && n >= 0 && n <= 255)) {
    const [a, b] = parts as [number, number, number, number];
    if (a === 0) return true;                                    // 0.0.0.0/8
    if (a === 10) return true;                                   // 10.0.0.0/8
    if (a === 127) return true;                                  // 127.0.0.0/8
    if (a === 169 && b === 254) return true;                     // 169.254.0.0/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                     // 192.168.0.0/16
  }

  return false;
}

function allowPrivateWebhookUrls() {
  return process.env.NODE_ENV !== "production";
}

const webhookCreateSchema = z.object({
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).default([...WEBHOOK_EVENT_TYPES]),
  secret: z
    .string()
    .trim()
    .min(32, "Custom webhook secret must be at least 32 characters.")
    .max(200, "Webhook secret must be 200 characters or fewer.")
    .optional(),
  url: z
    .string()
    .trim()
    .url("Webhook URL must be a valid URL.")
    .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
      message: "Webhook URL must use http or https.",
    })
    .refine((value) => allowPrivateWebhookUrls() || !isPrivateUrl(value), {
      message: "Webhook URL must not point to a private or internal address.",
    }),
});

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const BATCH_MAX_FILES = 20;
const OPENAPI_SPEC_PATHS = [
  path.resolve(process.cwd(), "docs/openapi.yaml"),
  path.resolve(process.cwd(), "dist/docs/openapi.yaml"),
];
const routesLogger = getLogger({ component: "routes" });

type ConversionOwner =
  | { scope: "user"; userId: number }
  | { scope: "visitor"; visitorId: string };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function getFirstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function getValidationMessage(error: z.ZodError) {
  return error.issues[0]?.message ?? "Invalid request.";
}

function serializeConversion(conversion: Conversion) {
  return {
    batchId: conversion.batchId,
    createdAt: conversion.createdAt?.toISOString() ?? null,
    convertedSize: conversion.convertedSize,
    engineUsed: conversion.engineUsed,
    expiresAt: conversion.expiresAt?.toISOString() ?? null,
    fileSize: conversion.fileSize,
    id: conversion.id,
    originalFormat: conversion.originalFormat,
    originalName: conversion.originalName,
    options: conversion.options ?? {},
    outputFilename: conversion.outputFilename,
    presetId: conversion.presetId,
    processingStartedAt: conversion.processingStartedAt?.toISOString() ?? null,
    resultMessage: conversion.resultMessage,
    status: conversion.status,
    targetFormat: conversion.targetFormat,
  };
}

function serializeUser(user: {
  createdAt: Date | null;
  email: string;
  id: number;
  plan: string;
  role: string;
}) {
  return {
    id: user.id,
    email: user.email,
    plan: user.plan,
    role: user.role,
    createdAt: user.createdAt?.toISOString() ?? null,
  };
}

function serializeApiKey(apiKey: {
  createdAt: Date | null;
  id: number;
  lastUsedAt: Date | null;
  name: string;
  revokedAt: Date | null;
}) {
  return {
    id: apiKey.id,
    name: apiKey.name,
    lastUsedAt: apiKey.lastUsedAt?.toISOString() ?? null,
    createdAt: apiKey.createdAt?.toISOString() ?? null,
    revokedAt: apiKey.revokedAt?.toISOString() ?? null,
  };
}

function serializeBatch(batch: {
  completedJobs: number;
  createdAt: Date | null;
  failedJobs: number;
  id: number;
  status: string;
  totalJobs: number;
}, jobs?: Conversion[]) {
  return {
    completedJobs: batch.completedJobs,
    createdAt: batch.createdAt?.toISOString() ?? null,
    failedJobs: batch.failedJobs,
    id: batch.id,
    jobs: jobs?.map((job) => serializeConversion(job)),
    status: batch.status,
    totalJobs: batch.totalJobs,
  };
}

function serializePreset(preset: {
  createdAt: Date | null;
  id: number;
  name: string;
  options: Record<string, unknown>;
  sourceFormat: string;
  targetFormat: string;
}) {
  return {
    createdAt: preset.createdAt?.toISOString() ?? null,
    id: preset.id,
    name: preset.name,
    options: preset.options,
    sourceFormat: preset.sourceFormat,
    targetFormat: preset.targetFormat,
  };
}

async function hashFileContents(filePath: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);

    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
    stream.on("error", (error) => {
      reject(error);
    });
  });
}

function getOptionalVisitorId(req: Request): string | null {
  const visitorId = getFirstValue(req.header(VISITOR_ID_HEADER));
  if (!isValidVisitorId(visitorId)) {
    return null;
  }

  return visitorId;
}

function requireVisitorId(req: Request, res: Response): string | undefined {
  const visitorId = getOptionalVisitorId(req);
  if (!visitorId) {
    res.status(400).json({ error: "A valid visitor id is required." });
    return undefined;
  }

  return visitorId;
}

function getUploadOwner(req: Request, res: Response) {
  if (req.user) {
    return {
      userId: req.user.id,
      visitorId: getOptionalVisitorId(req),
    };
  }

  const visitorId = requireVisitorId(req, res);
  if (!visitorId) {
    return undefined;
  }

  return {
    userId: null,
    visitorId,
  };
}

function getReadOwner(req: Request, res: Response): ConversionOwner | undefined {
  if (req.user) {
    return {
      scope: "user",
      userId: req.user.id,
    };
  }

  const visitorId = requireVisitorId(req, res);
  if (!visitorId) {
    return undefined;
  }

  return {
    scope: "visitor",
    visitorId,
  };
}

function canAccessConversion(conversion: Conversion, owner: ConversionOwner) {
  if (conversion.userId !== null) {
    return owner.scope === "user" && conversion.userId === owner.userId;
  }

  return owner.scope === "visitor" && conversion.visitorId === owner.visitorId;
}

ensureWorkingDirectories();

function createUploadMiddleware(maxFileSizeBytes: number) {
  return multer({
    storage: multer.diskStorage({
      destination: UPLOAD_TMP_DIR,
      filename: (_req, file, cb) => {
        const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
      },
    }),
    limits: { fileSize: maxFileSizeBytes },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).slice(1).toLowerCase();

      if (SUPPORTED_CONVERSIONS[ext]) {
        cb(null, true);
        return;
      }

      cb(new Error(`Unsupported file format: .${ext}`));
    },
  });
}

async function parseUploadedFile(
  req: Request,
  res: Response,
  plan: UserPlan,
) {
  const upload = createUploadMiddleware(getPlanLimits(plan).maxFileSizeBytes).single("file");

  return new Promise<Express.Multer.File>((resolve, reject) => {
    upload(req, res, (error) => {
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        reject(new HttpError(413, getFileSizeExceededMessage(plan)));
        return;
      }

      if (error) {
        reject(error instanceof Error ? new HttpError(400, error.message) : error);
        return;
      }

      if (!req.file) {
        reject(new HttpError(400, "No file uploaded."));
        return;
      }

      resolve(req.file);
    });
  });
}

async function parseUploadedFiles(
  req: Request,
  res: Response,
  plan: UserPlan,
) {
  const upload = createUploadMiddleware(getPlanLimits(plan).maxFileSizeBytes).array("files", BATCH_MAX_FILES);

  return new Promise<Express.Multer.File[]>((resolve, reject) => {
    upload(req, res, (error) => {
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        reject(new HttpError(413, getFileSizeExceededMessage(plan)));
        return;
      }

      if (
        error instanceof multer.MulterError &&
        (error.code === "LIMIT_FILE_COUNT" ||
          (error.code === "LIMIT_UNEXPECTED_FILE" && error.field === "files"))
      ) {
        reject(new HttpError(400, `Batch uploads are limited to ${BATCH_MAX_FILES} files.`));
        return;
      }

      if (error) {
        reject(error instanceof Error ? new HttpError(400, error.message) : error);
        return;
      }

      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length === 0) {
        reject(new HttpError(400, "No files uploaded."));
        return;
      }

      resolve(files);
    });
  });
}

function getRequestBaseUrl(req: Request) {
  const protocol = getFirstValue(req.header("x-forwarded-proto")) ?? req.protocol;
  const host = getFirstValue(req.header("x-forwarded-host")) ?? req.header("host");

  if (!host) {
    throw new HttpError(400, "Unable to determine the request host.");
  }

  return `${protocol}://${host}`;
}

function buildIdempotencyScope(owner: { userId: number | null; visitorId: string | null }) {
  if (owner.userId !== null) {
    return { userId: owner.userId } as const;
  }

  return { visitorId: owner.visitorId! } as const;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

function buildIdempotencyRequestHash(input: {
  fileHash: string;
  fileSize: number;
  options: Record<string, unknown>;
  presetId: number | null;
  sourceFormat: string;
  targetFormat: string;
}) {
  return hashSecret(stableStringify(input));
}

function getTextField(value: unknown) {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : undefined;
  }

  return typeof value === "string" ? value : undefined;
}

function parseJsonField(value: unknown, fieldLabel: string) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      throw new HttpError(400, `${fieldLabel} must be valid JSON.`);
    }
  }

  return value;
}

function requireObjectValue(value: unknown, fieldLabel: string) {
  if (value === undefined) {
    return {};
  }

  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new HttpError(400, `${fieldLabel} must be a JSON object.`);
  }

  return value as Record<string, unknown>;
}

function parseOptionalInteger(value: unknown, fieldLabel: string) {
  const raw = getTextField(value);
  if (raw === undefined || raw.trim() === "") {
    if (typeof value === "number" && Number.isInteger(value)) {
      return value;
    }

    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new HttpError(400, `${fieldLabel} must be a valid integer.`);
  }

  return parsed;
}

function validateTargetRoute(sourceFormat: string, targetFormat: string) {
  const validTargets = SUPPORTED_CONVERSIONS[sourceFormat];
  if (!validTargets || !validTargets.includes(targetFormat)) {
    throw new HttpError(400, `Cannot route .${sourceFormat} to .${targetFormat}.`);
  }
}

function validateConversionOptions(
  sourceFormat: string,
  targetFormat: string,
  options: Record<string, unknown>,
) {
  const parsed = getConversionOptionsSchema(sourceFormat, targetFormat).safeParse(options);
  if (!parsed.success) {
    throw new HttpError(400, getValidationMessage(parsed.error));
  }

  return parsed.data as Record<string, unknown>;
}

async function resolvePresetForRequest(userId: number | null, rawPresetId: unknown) {
  const presetId = parseOptionalInteger(rawPresetId, "Preset id");
  if (presetId === undefined) {
    return undefined;
  }

  if (userId === null) {
    throw new HttpError(401, "Authentication required to use presets.");
  }

  const preset = await storage.getPreset(presetId);
  if (!preset || preset.userId !== userId) {
    throw new HttpError(404, "Preset not found.");
  }

  return preset;
}

async function resolveConversionRequest(input: {
  ownerUserId: number | null;
  rawOptions: unknown;
  rawPresetId: unknown;
  rawTargetFormat: unknown;
  sourceFormat: string;
}) {
  const preset = await resolvePresetForRequest(input.ownerUserId, input.rawPresetId);
  const requestedTargetFormat = getTextField(input.rawTargetFormat)?.trim().toLowerCase();

  if (preset && requestedTargetFormat && requestedTargetFormat !== preset.targetFormat) {
    throw new HttpError(400, "Preset target format does not match the requested target format.");
  }

  if (preset && preset.sourceFormat !== input.sourceFormat) {
    throw new HttpError(
      400,
      `Preset "${preset.name}" only applies to .${preset.sourceFormat} files.`,
    );
  }

  const targetFormat = (requestedTargetFormat || preset?.targetFormat)?.toLowerCase();
  if (!targetFormat) {
    throw new HttpError(400, "Target format is required.");
  }

  validateTargetRoute(input.sourceFormat, targetFormat);

  const parsedOptions = requireObjectValue(parseJsonField(input.rawOptions, "Options"), "Options");
  const mergedOptions = preset
    ? { ...preset.options, ...parsedOptions }
    : parsedOptions;

  return {
    options: validateConversionOptions(input.sourceFormat, targetFormat, mergedOptions),
    presetId: preset?.id ?? null,
    targetFormat,
  };
}

async function enforceConversionAllowance(
  owner: { userId: number | null; visitorId: string | null },
  plan: UserPlan,
  requestedConversions = 1,
) {
  const planLimits = getPlanLimits(plan);
  if (planLimits.conversionsPerDay === null) {
    return;
  }

  const usageWindowStart = getStartOfCurrentUtcDay();
  const usageCount = owner.userId !== null
    ? await storage.countUsageEventsSince(owner.userId, "conversion", usageWindowStart)
    : await storage.countVisitorConversionsSince(owner.visitorId!, usageWindowStart);

  if (usageCount + requestedConversions > planLimits.conversionsPerDay) {
    throw new HttpError(429, getDailyUsageExceededMessage(plan));
  }
}

async function persistUploadedFile(file: Express.Multer.File) {
  const inputKey = getUploadObjectKey(file.filename);
  await filestore.save(file.path, inputKey);
  safeUnlink(file.path);
  return inputKey;
}

function cleanupUploadedFiles(files: Array<Express.Multer.File | null | undefined>) {
  for (const file of files) {
    safeUnlink(file?.path);
  }
}

function logQueuedConversion(
  req: Request,
  conversion: Pick<
    Conversion,
    "fileSize" | "id" | "status" | "targetFormat" | "userId" | "visitorId"
  > & { originalFormat?: string },
  sourceFormat: string,
  targetFormat: string,
) {
  getRequestLogger(req).info({
    conversionId: conversion.id,
    fileSize: conversion.fileSize,
    sourceFormat,
    status: conversion.status,
    targetFormat,
    userId: conversion.userId,
    visitorId: conversion.visitorId,
  }, "Conversion queued");
}

function requireUserContext(req: Request, res: Response) {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required." });
    return undefined;
  }

  return req.user;
}

function renderApiDocsHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ConvertFlow API Docs</title>
    <style>
      body { margin: 0; background: #f6f7fb; }
      redoc { display: block; min-height: 100vh; }
    </style>
  </head>
  <body>
    <redoc spec-url="/api/openapi.yaml"></redoc>
    <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
  </body>
</html>`;
}

function getUniqueArchiveName(filename: string, usedNames: Set<string>) {
  if (!usedNames.has(filename)) {
    usedNames.add(filename);
    return filename;
  }

  const parsed = path.parse(filename);
  let counter = 2;
  let candidate = `${parsed.name} (${counter})${parsed.ext}`;

  while (usedNames.has(candidate)) {
    counter += 1;
    candidate = `${parsed.name} (${counter})${parsed.ext}`;
  }

  usedNames.add(candidate);
  return candidate;
}

async function buildBatchArchive(conversions: Conversion[]) {
  const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), "convertflow-batch-"));
  const archivePath = path.join(workspace, "batch.zip");
  const usedNames = new Set<string>();
  const entries = [];

  for (const conversion of conversions) {
    if (!conversion.outputFilename) {
      continue;
    }

    const downloadName = getUniqueArchiveName(
      getDownloadFilename(conversion.originalName, conversion.targetFormat),
      usedNames,
    );
    const localPath = path.join(workspace, `${entries.length + 1}-${conversion.outputFilename}`);
    await filestore.get(getOutputObjectKey(conversion.outputFilename), localPath);
    entries.push({
      name: downloadName,
      sourcePath: localPath,
    });
  }

  if (entries.length === 0) {
    await fs.promises.rm(workspace, { force: true, recursive: true });
    throw new HttpError(404, "No completed batch outputs are available for download.");
  }

  await createZipArchive(archivePath, entries);

  return {
    archivePath,
    cleanup: () => fs.promises.rm(workspace, { force: true, recursive: true }),
  };
}

export async function registerRoutes(httpServer: Server, app: Express) {
  app.use(requestLogger);

  const authRateLimit = createRateLimiter(
    10,
    15 * 60 * 1000,
    "Too many attempts. Please try again later.",
  );
  ensureWorkingDirectories();
  await startQueueServerRuntime(httpServer, {
    onError: (error) => {
      routesLogger.error({ err: error }, "Queue runtime failed");
      captureException(error, {
        tags: {
          component: "routes",
        },
      });
    },
  });

  app.get("/api/health", async (_req: Request, res: Response) => {
    const health = await getHealthStatus();
    return res.status(health.status === "ok" ? 200 : 503).json(health);
  });

  app.get("/metrics", requireMonitoringAccess, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      setQueueMetrics(await getQueueMetricSamples());
      res.type(getMetricsContentType());
      return res.send(await renderMetrics());
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/formats", (_req: Request, res: Response) => {
    res.json(SUPPORTED_CONVERSIONS);
  });

  app.post("/api/auth/register", authRateLimit, async (req: Request, res: Response) => {
    const parsed = authCredentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: getValidationMessage(parsed.error) });
    }

    const existingUser = await storage.getUserByEmail(parsed.data.email);
    if (existingUser) {
      return res.status(409).json({ error: "An account already exists for that email." });
    }

    const passwordHash = await hashPassword(parsed.data.password);
    const { user, session } = await storage.createUserWithSession(
      {
        email: parsed.data.email,
        passwordHash,
        plan: "free",
        role: "user",
        stripeCustomerId: null,
        stripeSubscriptionId: null,
      },
      { userId: 0, token: createSessionToken(), expiresAt: createSessionExpiry() },
    );

    return res.status(201).json({
      token: session.token,
      user: serializeUser(user),
    });
  });

  app.post("/api/auth/login", authRateLimit, async (req: Request, res: Response) => {
    const parsed = authCredentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: getValidationMessage(parsed.error) });
    }

    const user = await storage.getUserByEmail(parsed.data.email);
    if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const session = await storage.createSession({
      userId: user.id,
      token: createSessionToken(),
      expiresAt: createSessionExpiry(),
    });

    return res.json({
      token: session.token,
      user: serializeUser(user),
    });
  });

  app.post("/api/auth/logout", requireAuth, async (req: Request, res: Response) => {
    if (req.authToken) {
      await storage.deleteSessionByToken(req.authToken);
    }

    return res.status(204).end();
  });

  app.get("/api/auth/me", requireAuth, (req: Request, res: Response) => {
    return res.json(serializeUser(req.user!));
  });

  app.get("/api/openapi.yaml", async (_req: Request, res: Response) => {
    try {
      const specPath = OPENAPI_SPEC_PATHS.find((candidate) => fs.existsSync(candidate));
      if (!specPath) {
        throw new Error("OpenAPI spec is unavailable.");
      }

      const spec = await fs.promises.readFile(specPath, "utf8");
      res.type("application/yaml");
      return res.send(spec);
    } catch (error) {
      const message = error instanceof Error ? error.message : "OpenAPI spec is unavailable.";
      return res.status(500).json({ error: message });
    }
  });

  app.get("/api/docs", (_req: Request, res: Response) => {
    res.type("html");
    return res.send(renderApiDocsHtml());
  });

  app.get("/api/keys", requireAuth, async (req: Request, res: Response) => {
    const apiKeys = await storage.listApiKeys(req.user!.id);
    return res.json({
      items: apiKeys.map((apiKey) => serializeApiKey(apiKey)),
    });
  });

  app.post("/api/keys", requireAuth, async (req: Request, res: Response) => {
    const parsed = apiKeyCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: getValidationMessage(parsed.error) });
    }

    const rawToken = createApiKeyToken();
    const apiKey = await storage.createApiKey({
      userId: req.user!.id,
      keyHash: hashSecret(rawToken),
      name: parsed.data.name,
      lastUsedAt: null,
      revokedAt: null,
    });

    return res.status(201).json({
      apiKey: serializeApiKey(apiKey),
      token: rawToken,
    });
  });

  app.delete("/api/keys/:id", requireAuth, async (req: Request, res: Response) => {
    const id = Number.parseInt(getFirstValue(req.params.id) ?? "", 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: "Invalid API key id." });
    }

    const revoked = await storage.revokeApiKey(id, req.user!.id);
    if (!revoked) {
      return res.status(404).json({ error: "API key not found." });
    }

    return res.status(204).end();
  });

  app.get("/api/presets", optionalApiAuth, async (req: Request, res: Response) => {
    const user = requireUserContext(req, res);
    if (!user) {
      return;
    }

    const presets = await storage.listPresets(user.id);
    return res.json({
      items: presets.map((preset) => serializePreset(preset)),
    });
  });

  app.post("/api/presets", optionalApiAuth, async (req: Request, res: Response) => {
    const user = requireUserContext(req, res);
    if (!user) {
      return;
    }

    const parsed = presetCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: getValidationMessage(parsed.error) });
    }

    try {
      validateTargetRoute(parsed.data.sourceFormat, parsed.data.targetFormat);
      const options = validateConversionOptions(
        parsed.data.sourceFormat,
        parsed.data.targetFormat,
        parsed.data.options,
      );

      const preset = await storage.createPreset({
        userId: user.id,
        name: parsed.data.name,
        sourceFormat: parsed.data.sourceFormat,
        targetFormat: parsed.data.targetFormat,
        options,
      });

      return res.status(201).json({
        preset: serializePreset(preset),
      });
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).json({ error: error.message });
      }

      throw error;
    }
  });

  app.delete("/api/presets/:id", optionalApiAuth, async (req: Request, res: Response) => {
    const user = requireUserContext(req, res);
    if (!user) {
      return;
    }

    const id = Number.parseInt(getFirstValue(req.params.id) ?? "", 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: "Invalid preset id." });
    }

    const deleted = await storage.deletePreset(id, user.id);
    if (!deleted) {
      return res.status(404).json({ error: "Preset not found." });
    }

    return res.status(204).end();
  });

  app.post("/api/webhooks", requireAuth, async (req: Request, res: Response) => {
    const parsed = webhookCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: getValidationMessage(parsed.error) });
    }

    const secret = parsed.data.secret?.trim() || createWebhookSecret();
    const webhook = await storage.createWebhook({
      userId: req.user!.id,
      url: parsed.data.url,
      events: parsed.data.events,
      secret,
    });

    return res.status(201).json({
      secret,
      webhook: serializeWebhook(webhook),
    });
  });

  app.delete("/api/webhooks/:id", requireAuth, async (req: Request, res: Response) => {
    const id = Number.parseInt(getFirstValue(req.params.id) ?? "", 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: "Invalid webhook id." });
    }

    const deleted = await storage.deleteWebhook(id, req.user!.id);
    if (!deleted) {
      return res.status(404).json({ error: "Webhook not found." });
    }

    return res.status(204).end();
  });

  app.post("/api/billing/checkout", requireAuth, async (req: Request, res: Response) => {
    if (!isBillingConfigured()) {
      return res.status(503).json({ error: "Stripe billing is not configured." });
    }

    const parsed = billingCheckoutSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: getValidationMessage(parsed.error) });
    }

    const user = await storage.getUserById(req.user!.id);
    if (!user) {
      return res.status(401).json({ error: "Authentication required." });
    }

    const requestedPlan = parsed.data.plan;
    const currentPlan = req.user!.plan;
    if (requestedPlan === currentPlan) {
      return res.status(409).json({ error: `Your account is already on the ${requestedPlan} plan.` });
    }

    if (getPlanRank(requestedPlan) <= getPlanRank(currentPlan)) {
      return res.status(400).json({ error: "Use the billing portal to change or cancel your current plan." });
    }

    try {
      const session = await createBillingCheckoutSession({
        baseUrl: getRequestBaseUrl(req),
        plan: requestedPlan,
        user,
      });

      if (session.customerId !== user.stripeCustomerId) {
        await storage.updateUser(user.id, {
          stripeCustomerId: session.customerId,
        });
      }

      return res.json(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create Stripe checkout session.";
      return res.status(502).json({ error: message });
    }
  });

  app.post("/api/billing/portal", requireAuth, async (req: Request, res: Response) => {
    if (!isBillingConfigured()) {
      return res.status(503).json({ error: "Stripe billing is not configured." });
    }

    const user = await storage.getUserById(req.user!.id);
    if (!user) {
      return res.status(401).json({ error: "Authentication required." });
    }

    if (!user.stripeCustomerId) {
      return res.status(400).json({ error: "No billing profile exists for this account yet." });
    }

    try {
      const session = await createBillingPortalSession({
        baseUrl: getRequestBaseUrl(req),
        user,
      });

      return res.json(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create Stripe billing portal session.";
      return res.status(502).json({ error: message });
    }
  });

  app.post("/api/billing/webhook", async (req: Request, res: Response) => {
    if (!isBillingConfigured()) {
      return res.status(503).json({ error: "Stripe billing is not configured." });
    }

    const signature = getFirstValue(req.header("stripe-signature"));
    if (!signature) {
      return res.status(400).json({ error: "Stripe signature header is required." });
    }

    if (!Buffer.isBuffer(req.rawBody)) {
      return res.status(400).json({ error: "Stripe webhook requires a raw request body." });
    }

    try {
      const event = constructStripeWebhookEvent(req.rawBody, signature);
      await syncStripeBillingEvent(event);
      return res.json({ received: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid Stripe webhook payload.";
      return res.status(400).json({ error: message });
    }
  });

  app.post("/api/batch", optionalApiAuth, async (req: Request, res: Response) => {
    const user = requireUserContext(req, res);
    if (!user) {
      cleanupUploadedFiles(Array.isArray(req.files) ? req.files : []);
      return;
    }

    const visitorId = getOptionalVisitorId(req);
    const plan = getEffectivePlan(user.plan);
    const idempotencyKey = getFirstValue(req.header("idempotency-key"))?.trim() || null;
    const idempotencyKeyHash = idempotencyKey ? hashSecret(idempotencyKey) : null;
    let batchRequestHash: string | null = null;

    let files: Express.Multer.File[] = [];
    let batch: Batch | null = null;
    const createdConversions: Conversion[] = [];
    const persistedInputKeys: string[] = [];

    try {
      files = await parseUploadedFiles(req, res, plan);

      const resolvedRequests = await Promise.all(files.map(async (file) => {
        const sourceFormat = path.extname(file.originalname).slice(1).toLowerCase();

        const resolved = await resolveConversionRequest({
          ownerUserId: user.id,
          rawOptions: req.body.options,
          rawPresetId: req.body.presetId,
          rawTargetFormat: req.body.targetFormat,
          sourceFormat,
        });

        return {
          ...resolved,
          sourceFormat,
        };
      }));

      if (idempotencyKeyHash) {
        const fileHashes = await Promise.all(files.map((file) => hashFileContents(file.path)));
        batchRequestHash = hashSecret(stableStringify(
          files.map((file, index) => ({
            fileHash: fileHashes[index],
            fileSize: file.size,
            options: resolvedRequests[index]!.options,
            presetId: resolvedRequests[index]!.presetId,
            sourceFormat: resolvedRequests[index]!.sourceFormat,
            targetFormat: resolvedRequests[index]!.targetFormat,
          })),
        ));

        const existingKey = await storage.getIdempotencyKey(idempotencyKeyHash, { userId: user.id });
        if (existingKey) {
          cleanupUploadedFiles(files);
          if (existingKey.requestHash !== batchRequestHash) {
            return res.status(409).json({
              error: "Idempotency key has already been used for a different request.",
            });
          }

          return res
            .status(existingKey.responseStatus)
            .json(JSON.parse(existingKey.responseBody) as unknown);
        }
      }

      await enforceConversionAllowance({ userId: user.id, visitorId }, plan, files.length);

      const expiresAt = getPlanRetentionDeadline(plan);

      for (const file of files) {
        const inputKey = await persistUploadedFile(file);
        persistedInputKeys.push(inputKey);
      }

      const result = await storage.createBatchWithConversions(
        {
          userId: user.id,
          status: "pending",
          totalJobs: files.length,
          completedJobs: 0,
          failedJobs: 0,
        },
        files.map((file, index) => ({
          originalName: file.originalname,
          originalFormat: resolvedRequests[index]!.sourceFormat,
          targetFormat: resolvedRequests[index]!.targetFormat,
          inputKey: persistedInputKeys[index]!,
          status: "pending" as const,
          fileSize: file.size,
          outputFilename: null,
          resultMessage: formatQueuedMessage(resolvedRequests[index]!.sourceFormat, resolvedRequests[index]!.targetFormat),
          userId: user.id,
          visitorId,
          presetId: resolvedRequests[index]!.presetId,
          options: resolvedRequests[index]!.options,
          expiresAt,
        })),
      );
      batch = result.batch;
      createdConversions.push(...result.conversions);

      for (let index = 0; index < createdConversions.length; index += 1) {
        const conversion = createdConversions[index]!;
        await scheduleConversionExpiryJob({ conversionId: conversion.id }, expiresAt);
        await enqueueConversionJob({
          conversionId: conversion.id,
          inputKey: persistedInputKeys[index]!,
          sourceFormat: resolvedRequests[index]!.sourceFormat,
          targetFormat: resolvedRequests[index]!.targetFormat,
        });
        logQueuedConversion(
          req,
          conversion,
          resolvedRequests[index]!.sourceFormat,
          resolvedRequests[index]!.targetFormat,
        );
      }

      const syncedBatch = await storage.syncBatch(batch.id) ?? batch;
      const responseBody = serializeBatch(syncedBatch, createdConversions);

      if (idempotencyKeyHash && batchRequestHash) {
        await storage.createIdempotencyKey({
          keyHash: idempotencyKeyHash,
          requestHash: batchRequestHash,
          responseStatus: 201,
          responseBody: JSON.stringify(responseBody),
          userId: user.id,
          visitorId: null,
          conversionId: null,
          expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
        });
      }

      return res.status(201).json(responseBody);
    } catch (err: unknown) {
      cleanupUploadedFiles(files);

      await Promise.all(
        persistedInputKeys.map(async (inputKey) => {
          try {
            await filestore.delete(inputKey);
          } catch (deleteError) {
            getRequestLogger(req).error({ err: deleteError, inputKey }, "Failed to delete uploaded object");
          }
        }),
      );

      await Promise.all([
        ...createdConversions.map(async (conversion) => {
          try {
            await storage.deleteConversion(conversion.id);
          } catch (deleteError) {
            getRequestLogger(req).error({ conversionId: conversion.id, err: deleteError }, "Failed to delete conversion record");
          }
        }),
        ...(batch
          ? [storage.deleteBatch(batch.id).catch((deleteError: unknown) => {
              getRequestLogger(req).error({ batchId: batch!.id, err: deleteError }, "Failed to delete batch record");
            })]
          : []),
      ]);

      if (err instanceof HttpError) {
        return res.status(err.status).json({ error: err.message });
      }

      const error = err as Error;
      return res.status(500).json({ error: error.message || "Batch conversion failed." });
    }
  });

  app.get("/api/batch/:id", optionalApiAuth, async (req: Request, res: Response) => {
    const user = requireUserContext(req, res);
    if (!user) {
      return;
    }

    const id = Number.parseInt(getFirstValue(req.params.id) ?? "", 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: "Invalid batch id." });
    }

    const batch = await storage.getBatch(id);
    if (!batch || batch.userId !== user.id) {
      return res.status(404).json({ error: "Batch not found." });
    }

    const syncedBatch = await storage.syncBatch(batch.id);
    if (!syncedBatch) {
      return res.status(404).json({ error: "Batch not found." });
    }

    const jobs = await storage.listBatchConversions(id);
    return res.json(serializeBatch(syncedBatch, jobs));
  });

  app.get("/api/batch/:id/download", optionalApiAuth, async (req: Request, res: Response, next: NextFunction) => {
    const user = requireUserContext(req, res);
    if (!user) {
      return;
    }

    const id = Number.parseInt(getFirstValue(req.params.id) ?? "", 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: "Invalid batch id." });
    }

    const batch = await storage.getBatch(id);
    if (!batch || batch.userId !== user.id) {
      return res.status(404).json({ error: "Batch not found." });
    }

    try {
      const jobs = (await storage.listBatchConversions(id)).filter((conversion) => (
        conversion.status === "completed" &&
        conversion.outputFilename !== null &&
        (!conversion.expiresAt || conversion.expiresAt.getTime() > Date.now())
      ));

      const archive = await buildBatchArchive(jobs);
      res.download(archive.archivePath, `batch-${id}.zip`, async (error) => {
        try {
          await archive.cleanup();
        } catch (cleanupError) {
          getRequestLogger(req).error({ batchId: id, err: cleanupError }, "Failed to clean up batch archive workspace");
        }

        if (!error) {
          return;
        }

        if (!res.headersSent) {
          next(error);
        }
      });
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).json({ error: error.message });
      }

      return next(error);
    }
  });

  app.post("/api/convert", optionalApiAuth, async (req: Request, res: Response) => {
    const owner = getUploadOwner(req, res);
    if (!owner) {
      safeUnlink(req.file?.path);
      return;
    }

    const plan = getEffectivePlan(req.user?.plan);
    const idempotencyKey = getFirstValue(req.header("idempotency-key"))?.trim() || null;
    const idempotencyKeyHash = idempotencyKey ? hashSecret(idempotencyKey) : null;

    let conversion: Conversion | null = null;
    let inputKey: string | null = null;
    let file: Express.Multer.File | null = null;
    let options: Record<string, unknown> = {};
    let presetId: number | null = null;
    let requestHash: string | null = null;
    let sourceFormat: string | null = null;
    let targetFormat: string | null = null;

    try {
      file = await parseUploadedFile(req, res, plan);

      sourceFormat = path.extname(file.originalname).slice(1).toLowerCase();
      ({ options, presetId, targetFormat } = await resolveConversionRequest({
        ownerUserId: owner.userId,
        rawOptions: req.body.options,
        rawPresetId: req.body.presetId,
        rawTargetFormat: req.body.targetFormat,
        sourceFormat,
      }));

      if (idempotencyKeyHash) {
        requestHash = buildIdempotencyRequestHash({
          fileHash: await hashFileContents(file.path),
          fileSize: file.size,
          sourceFormat,
          targetFormat,
          options,
          presetId,
        });

        const existingKey = await storage.getIdempotencyKey(
          idempotencyKeyHash,
          buildIdempotencyScope(owner),
        );

        if (existingKey) {
          safeUnlink(file.path);

          if (existingKey.requestHash !== requestHash) {
            return res.status(409).json({
              error: "Idempotency key has already been used for a different request.",
            });
          }

          return res
            .status(existingKey.responseStatus)
            .json(JSON.parse(existingKey.responseBody) as unknown);
        }
      }

      await enforceConversionAllowance(owner, plan, 1);

      const expiresAt = getPlanRetentionDeadline(plan);
      inputKey = await persistUploadedFile(file);

      conversion = await storage.createConversion({
        originalName: file.originalname,
        originalFormat: sourceFormat,
        targetFormat,
        inputKey,
        status: "pending",
        fileSize: file.size,
        outputFilename: null,
        processingStartedAt: null,
        engineUsed: null,
        resultMessage: formatQueuedMessage(sourceFormat, targetFormat),
        userId: owner.userId,
        visitorId: owner.visitorId,
        batchId: null,
        presetId,
        options,
        expiresAt,
      });

      const responseBody = serializeConversion(conversion);

      await scheduleConversionExpiryJob({ conversionId: conversion.id }, expiresAt);
      await enqueueConversionJob({
        conversionId: conversion.id,
        inputKey,
        sourceFormat,
        targetFormat,
      });
      logQueuedConversion(req, conversion, sourceFormat, targetFormat);

      if (idempotencyKeyHash && requestHash) {
        await storage.createIdempotencyKey({
          keyHash: idempotencyKeyHash,
          requestHash,
          responseStatus: 201,
          responseBody: JSON.stringify(responseBody),
          userId: owner.userId,
          visitorId: owner.visitorId,
          conversionId: conversion.id,
          expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
        });
      }

      return res.status(201).json(responseBody);
    } catch (err: unknown) {
      cleanupUploadedFiles([file, req.file]);
      if (inputKey) {
        try {
          await filestore.delete(inputKey);
        } catch (deleteError) {
          getRequestLogger(req).error({ err: deleteError, inputKey }, "Failed to delete uploaded object");
        }
      }
      if (conversion) {
        await storage.deleteConversion(conversion.id);
      }
      if (err instanceof HttpError) {
        return res.status(err.status).json({ error: err.message });
      }
      const error = err as Error;
      return res.status(500).json({ error: error.message || "Conversion failed." });
    }
  });

  app.get("/api/convert/:id", optionalApiAuth, async (req: Request, res: Response) => {
    const owner = getReadOwner(req, res);
    if (!owner) {
      return;
    }

    const idParam = getFirstValue(req.params.id);
    const id = Number.parseInt(idParam ?? "", 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: "Invalid conversion id." });
    }

    const conversion = await storage.getConversion(id);
    if (!conversion || !canAccessConversion(conversion, owner)) {
      return res.status(404).json({ error: "Conversion not found." });
    }

    if (conversion.expiresAt && conversion.expiresAt.getTime() <= Date.now()) {
      await expireConversionRecord(conversion);
      return res.status(404).json({ error: "Conversion expired." });
    }

    return res.json(serializeConversion(conversion));
  });

  app.post("/api/convert/:id/retry", optionalApiAuth, async (req: Request, res: Response) => {
    const owner = getReadOwner(req, res);
    if (!owner) {
      return;
    }

    const id = Number.parseInt(getFirstValue(req.params.id) ?? "", 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: "Invalid conversion id." });
    }

    const conversion = await storage.getConversion(id);
    if (!conversion || !canAccessConversion(conversion, owner)) {
      return res.status(404).json({ error: "Conversion not found." });
    }

    if (conversion.expiresAt && conversion.expiresAt.getTime() <= Date.now()) {
      await expireConversionRecord(conversion);
      return res.status(404).json({ error: "Conversion expired." });
    }

    if (conversion.status !== "failed") {
      return res.status(409).json({ error: "Only failed conversions can be retried." });
    }

    if (!conversion.inputKey || !(await filestore.exists(conversion.inputKey))) {
      return res.status(409).json({
        error: "The original input file is no longer available for retry.",
      });
    }

    const plan = getEffectivePlan(req.user?.plan);

    try {
      await enforceConversionAllowance(
        {
          userId: conversion.userId,
          visitorId: conversion.visitorId,
        },
        plan,
        1,
      );

      const retried = await storage.updateConversion(conversion.id, {
        convertedSize: null,
        engineUsed: null,
        outputFilename: null,
        processingStartedAt: null,
        resultMessage: formatQueuedMessage(conversion.originalFormat, conversion.targetFormat),
        status: "pending",
      });

      if (!retried) {
        return res.status(404).json({ error: "Conversion not found." });
      }

      if (retried.batchId) {
        await storage.syncBatch(retried.batchId);
      }

      if (retried.expiresAt) {
        await scheduleConversionExpiryJob({ conversionId: retried.id }, retried.expiresAt);
      }

      await enqueueConversionJob({
        conversionId: retried.id,
        inputKey: retried.inputKey!,
        sourceFormat: retried.originalFormat,
        targetFormat: retried.targetFormat,
      });
      logQueuedConversion(req, retried, retried.originalFormat, retried.targetFormat);

      return res.json(serializeConversion(retried));
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).json({ error: error.message });
      }

      const message = error instanceof Error ? error.message : "Retry failed.";
      return res.status(500).json({ error: message });
    }
  });

  app.get("/api/download/local", (req: Request, res: Response, next: NextFunction) => {
    const params = parseLocalDownloadParams(
      req.query as Record<string, string | string[] | undefined>,
    );

    if (!params) {
      return res.status(404).json({ error: "Download expired." });
    }

    return res.download(getLocalPathFromDownloadKey(params.key), params.filename, (error) => {
      if (!error) {
        return;
      }

      if (!res.headersSent && (error as NodeJS.ErrnoException).code === "ENOENT") {
        res.status(404).json({ error: "The converted file is no longer available." });
        return;
      }

      next(error);
    });
  });

  app.get("/api/download/:filename", optionalApiAuth, async (req: Request, res: Response) => {
    const owner = getReadOwner(req, res);
    if (!owner) {
      return;
    }

    const filename = getFirstValue(req.params.filename);
    if (!filename || filename.includes("..") || filename.includes("/")) {
      return res.status(400).json({ error: "Invalid filename." });
    }

    const conversion = await storage.getConversionByOutputFilename(filename);
    if (!conversion || !canAccessConversion(conversion, owner)) {
      return res.status(404).json({ error: "Download not found." });
    }

    if (conversion.expiresAt && conversion.expiresAt.getTime() <= Date.now()) {
      await expireConversionRecord(conversion);
      return res.status(404).json({ error: "Download expired." });
    }

    const downloadUrl = await filestore.getDownloadUrl(
      getOutputObjectKey(filename),
      getDownloadFilename(conversion.originalName, conversion.targetFormat),
    );

    return res.redirect(downloadUrl);
  });

  app.get("/api/conversions", optionalApiAuth, async (req: Request, res: Response) => {
    const parsedQuery = historyQuerySchema.safeParse({
      format: getFirstValue(req.query.format as string | string[] | undefined),
      limit: getFirstValue(req.query.limit as string | string[] | undefined),
      page: getFirstValue(req.query.page as string | string[] | undefined),
      status: getFirstValue(req.query.status as string | string[] | undefined) as
        | ConversionStatus
        | undefined,
    });

    if (!parsedQuery.success) {
      return res.status(400).json({ error: getValidationMessage(parsedQuery.error) });
    }

    const scope = req.user
      ? { userId: req.user.id }
      : { visitorId: requireVisitorId(req, res) };

    if ("visitorId" in scope && !scope.visitorId) {
      return;
    }

    const result = await storage.listConversions({
      ...parsedQuery.data,
      ...scope,
    });

    return res.json({
      items: result.items.map((conversion) => serializeConversion(conversion)),
      limit: result.limit,
      page: result.page,
      total: result.total,
      totalPages: Math.ceil(result.total / result.limit),
    });
  });

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "File too large for the current plan." });
      }

      return res.status(400).json({ error: err.message });
    }

    if (err instanceof Error) {
      return res.status(400).json({ error: err.message });
    }

    return next();
  });
}
