import type { Express, NextFunction, Request, Response } from "express";
import type { Server } from "http";
import { createHash } from "node:crypto";
import fs from "node:fs";
import multer from "multer";
import path from "path";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import {
  CONVERSION_STATUSES,
  type Conversion,
  type ConversionStatus,
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
import {
  enqueueConversionJob,
  scheduleConversionExpiryJob,
  startQueueServerRuntime,
} from "./queue";
import { storage } from "./storage";
import { createWebhookSecret, serializeWebhook } from "./webhooks";

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
    .refine((value) => !isPrivateUrl(value), {
      message: "Webhook URL must not point to a private or internal address.",
    }),
});

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const OPENAPI_SPEC_PATHS = [
  path.resolve(process.cwd(), "docs/openapi.yaml"),
  path.resolve(process.cwd(), "dist/docs/openapi.yaml"),
];

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
    id: conversion.id,
    originalName: conversion.originalName,
    originalFormat: conversion.originalFormat,
    targetFormat: conversion.targetFormat,
    status: conversion.status,
    fileSize: conversion.fileSize,
    convertedSize: conversion.convertedSize,
    outputFilename: conversion.outputFilename,
    resultMessage: conversion.resultMessage,
    engineUsed: conversion.engineUsed,
    expiresAt: conversion.expiresAt?.toISOString() ?? null,
    createdAt: conversion.createdAt?.toISOString() ?? null,
    processingStartedAt: conversion.processingStartedAt?.toISOString() ?? null,
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

function buildIdempotencyRequestHash(input: {
  fileHash: string;
  fileSize: number;
  sourceFormat: string;
  targetFormat: string;
}) {
  return hashSecret(JSON.stringify(input));
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

export async function registerRoutes(httpServer: Server, app: Express) {
  const authRateLimit = createRateLimiter(
    10,
    15 * 60 * 1000,
    "Too many attempts. Please try again later.",
  );
  ensureWorkingDirectories();
  await startQueueServerRuntime(httpServer, {
    onError: (error) => {
      console.error("Queue runtime failed:", error);
    },
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

  app.post("/api/convert", optionalApiAuth, async (req: Request, res: Response) => {
    const owner = getUploadOwner(req, res);
    if (!owner) {
      safeUnlink(req.file?.path);
      return;
    }

    const plan = getEffectivePlan(req.user?.plan);
    const planLimits = getPlanLimits(plan);
    const usageWindowStart = getStartOfCurrentUtcDay();
    const idempotencyKey = getFirstValue(req.header("idempotency-key"))?.trim() || null;
    const idempotencyKeyHash = idempotencyKey ? hashSecret(idempotencyKey) : null;

    let conversion: Conversion | null = null;
    let inputKey: string | null = null;
    let file: Express.Multer.File | null = null;
    let requestHash: string | null = null;

    try {
      file = await parseUploadedFile(req, res, plan);

      const targetFormat = getFirstValue(req.body.targetFormat)?.toLowerCase();
      if (!targetFormat) {
        safeUnlink(file.path);
        return res.status(400).json({ error: "Target format is required." });
      }

      const sourceFormat = path.extname(file.originalname).slice(1).toLowerCase();
      const validTargets = SUPPORTED_CONVERSIONS[sourceFormat];
      if (!validTargets || !validTargets.includes(targetFormat)) {
        safeUnlink(file.path);
        return res.status(400).json({
          error: `Cannot route .${sourceFormat} to .${targetFormat}.`,
        });
      }

      if (idempotencyKeyHash) {
        requestHash = buildIdempotencyRequestHash({
          fileHash: await hashFileContents(file.path),
          fileSize: file.size,
          sourceFormat,
          targetFormat,
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

      if (planLimits.conversionsPerDay !== null) {
        const usageCount = owner.userId !== null
          ? await storage.countUsageEventsSince(owner.userId, "conversion", usageWindowStart)
          : await storage.countVisitorConversionsSince(owner.visitorId!, usageWindowStart);

        if (usageCount >= planLimits.conversionsPerDay) {
          safeUnlink(file.path);
          return res.status(429).json({ error: getDailyUsageExceededMessage(plan) });
        }
      }

      const expiresAt = getPlanRetentionDeadline(plan);
      inputKey = getUploadObjectKey(file.filename);
      await filestore.save(file.path, inputKey);
      safeUnlink(file.path);

      conversion = await storage.createConversion({
        originalName: file.originalname,
        originalFormat: sourceFormat,
        targetFormat,
        status: "pending",
        fileSize: file.size,
        outputFilename: null,
        processingStartedAt: null,
        engineUsed: null,
        resultMessage: formatQueuedMessage(sourceFormat, targetFormat),
        userId: owner.userId,
        visitorId: owner.visitorId,
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
      safeUnlink(file?.path ?? req.file?.path);
      if (inputKey) {
        try {
          await filestore.delete(inputKey);
        } catch (deleteError) {
          console.error(`Failed to delete uploaded object: ${inputKey}`, deleteError);
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
