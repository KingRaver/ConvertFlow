import type { Express, NextFunction, Request, Response } from "express";
import type { Server } from "http";
import multer from "multer";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import type { Conversion } from "@shared/schema";
import { SUPPORTED_CONVERSIONS } from "@shared/schema";
import { VISITOR_ID_HEADER, isValidVisitorId } from "@shared/visitor";
import { FILE_TTL_MS, OUTPUT_DIR, UPLOAD_DIR, ensureWorkingDirectories, safeUnlink } from "./files";
import { expireConversionRecord, formatQueuedMessage } from "./conversion-jobs";
import {
  enqueueConversionJob,
  scheduleConversionExpiryJob,
  startQueueServerRuntime,
} from "./queue";
import { storage } from "./storage";

function getFirstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function serializeConversion(conversion: Conversion) {
  return {
    ...conversion,
    expiresAt: conversion.expiresAt?.toISOString() ?? null,
    createdAt: conversion.createdAt?.toISOString() ?? null,
    processingStartedAt: conversion.processingStartedAt?.toISOString() ?? null,
  };
}

function getVisitorId(req: Request, res: Response): string | undefined {
  const visitorId = getFirstValue(req.header(VISITOR_ID_HEADER));

  if (!isValidVisitorId(visitorId)) {
    res.status(400).json({ error: "A valid visitor id is required." });
    return undefined;
  }

  return visitorId;
}

ensureWorkingDirectories();

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
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
  ensureWorkingDirectories();
  await startQueueServerRuntime(httpServer, {
    onError: (error) => {
      console.error("Queue runtime failed:", error);
    },
  });

  app.get("/api/formats", (_req: Request, res: Response) => {
    res.json(SUPPORTED_CONVERSIONS);
  });

  app.post("/api/convert", upload.single("file"), async (req: Request, res: Response) => {
    const visitorId = getVisitorId(req, res);
    if (!visitorId) {
      safeUnlink(req.file?.path);
      return;
    }

    let conversion: Conversion | null = null;

    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: "No file uploaded." });
      }

      const targetFormat = req.body.targetFormat?.toLowerCase();
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
        visitorId,
        expiresAt,
      });

      await scheduleConversionExpiryJob({ conversionId: conversion.id }, expiresAt);
      await enqueueConversionJob({
        conversionId: conversion.id,
        inputPath: file.path,
        sourceFormat,
        targetFormat,
      });

      return res.status(201).json(serializeConversion(conversion));
    } catch (err: unknown) {
      safeUnlink(req.file?.path);
      if (conversion) {
        await storage.deleteConversion(conversion.id);
      }
      const error = err as Error;
      return res.status(500).json({ error: error.message || "Conversion failed." });
    }
  });

  app.get("/api/convert/:id", async (req: Request, res: Response) => {
    const visitorId = getVisitorId(req, res);
    if (!visitorId) {
      return;
    }

    const idParam = getFirstValue(req.params.id);
    const id = Number.parseInt(idParam ?? "", 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: "Invalid conversion id." });
    }

    const conversion = await storage.getConversion(id);
    if (!conversion || conversion.visitorId !== visitorId) {
      return res.status(404).json({ error: "Conversion not found." });
    }

    if (conversion.expiresAt && conversion.expiresAt.getTime() <= Date.now()) {
      await expireConversionRecord(conversion);
      return res.status(404).json({ error: "Conversion expired." });
    }

    return res.json(serializeConversion(conversion));
  });

  app.get("/api/download/:filename", async (req: Request, res: Response) => {
    const visitorId = getVisitorId(req, res);
    if (!visitorId) {
      return;
    }

    const filename = getFirstValue(req.params.filename);
    if (!filename || filename.includes("..") || filename.includes("/")) {
      return res.status(400).json({ error: "Invalid filename." });
    }

    const conversion = await storage.getConversionByOutputFilename(filename);
    if (!conversion || conversion.visitorId !== visitorId) {
      return res.status(404).json({ error: "Download not found." });
    }

    if (conversion.expiresAt && conversion.expiresAt.getTime() <= Date.now()) {
      await expireConversionRecord(conversion);
      return res.status(404).json({ error: "Download expired." });
    }

    const filePath = path.join(OUTPUT_DIR, filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: "The converted file is no longer available.",
      });
    }

    return res.download(filePath, filename);
  });

  app.get("/api/conversions", async (req: Request, res: Response) => {
    const visitorId = getVisitorId(req, res);
    if (!visitorId) {
      return;
    }

    const conversions = await storage.getConversionsByVisitor(visitorId);

    return res.json(conversions.map((conversion) => serializeConversion(conversion)));
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
