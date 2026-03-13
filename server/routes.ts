import type { Express, NextFunction, Request, Response } from "express";
import type { Server } from "http";
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
} from "@shared/schema";
import { VISITOR_ID_HEADER, isValidVisitorId } from "@shared/visitor";
import {
  createSessionExpiry,
  createSessionToken,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  normalizeEmail,
  verifyPassword,
} from "./auth";
import { expireConversionRecord, formatQueuedMessage } from "./conversion-jobs";
import {
  FILE_TTL_MS,
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
import { getLocalPathFromDownloadKey, parseLocalDownloadParams } from "./filestore/local";
import { optionalAuth, requireAuth } from "./middleware/auth";
import { createRateLimiter } from "./middleware/rateLimit";
import {
  enqueueConversionJob,
  scheduleConversionExpiryJob,
  startQueueServerRuntime,
} from "./queue";
import { storage } from "./storage";

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

type ConversionOwner =
  | { scope: "user"; userId: number }
  | { scope: "visitor"; visitorId: string };

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
  role: string;
}) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt?.toISOString() ?? null,
  };
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

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_TMP_DIR,
    filename: (_req, file, cb) => {
      const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
      cb(null, uniqueName);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(1).toLowerCase();

    if (SUPPORTED_CONVERSIONS[ext]) {
      cb(null, true);
      return;
    }

    cb(new Error(`Unsupported file format: .${ext}`));
  },
});

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
      { email: parsed.data.email, passwordHash, role: "user" },
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

  app.post("/api/convert", optionalAuth, upload.single("file"), async (req: Request, res: Response) => {
    const owner = getUploadOwner(req, res);
    if (!owner) {
      safeUnlink(req.file?.path);
      return;
    }

    let conversion: Conversion | null = null;
    let inputKey: string | null = null;

    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: "No file uploaded." });
      }

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

      const expiresAt = new Date(Date.now() + FILE_TTL_MS);
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

      await scheduleConversionExpiryJob({ conversionId: conversion.id }, expiresAt);
      await enqueueConversionJob({
        conversionId: conversion.id,
        inputKey,
        sourceFormat,
        targetFormat,
      });

      return res.status(201).json(serializeConversion(conversion));
    } catch (err: unknown) {
      safeUnlink(req.file?.path);
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
      const error = err as Error;
      return res.status(500).json({ error: error.message || "Conversion failed." });
    }
  });

  app.get("/api/convert/:id", optionalAuth, async (req: Request, res: Response) => {
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

  app.get("/api/download/:filename", optionalAuth, async (req: Request, res: Response) => {
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

  app.get("/api/conversions", optionalAuth, async (req: Request, res: Response) => {
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
        return res.status(413).json({ error: "File too large. Maximum size is 50MB." });
      }

      return res.status(400).json({ error: err.message });
    }

    if (err instanceof Error) {
      return res.status(400).json({ error: err.message });
    }

    return next();
  });
}
