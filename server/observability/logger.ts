import crypto from "node:crypto";
import type { Request } from "express";
import pino from "pino";
import pinoHttp from "pino-http";
import { VISITOR_ID_HEADER } from "@shared/visitor";

const serviceName = process.env.OBSERVABILITY_SERVICE_NAME?.trim() || "convertflow";
const logLevel = process.env.LOG_LEVEL?.trim() || (
  process.env.NODE_ENV === "production" ? "info" : "debug"
);

export const logger = pino({
  base: {
    service: serviceName,
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  level: logLevel,
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type AppLogger = typeof logger;

declare global {
  namespace Express {
    interface Request {
      id?: string;
      log: AppLogger;
    }
  }
}

function getRequestId(req: Request) {
  const headerValue = req.header("x-request-id")?.trim();
  return headerValue || crypto.randomUUID();
}

export function getRequestLogger(req: Request) {
  return req.log ?? logger;
}

export function getLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}

export const requestLogger = pinoHttp({
  customErrorMessage: () => "request errored",
  customLogLevel: (_req, res, error) => {
    if (error || res.statusCode >= 500) {
      return "error";
    }

    if (res.statusCode >= 400) {
      return "warn";
    }

    return "info";
  },
  customProps: (req) => {
    const request = req as Request;
    return {
      apiKeyId: request.apiKeyId ?? null,
      authType: request.authType ?? null,
      requestId: request.id ?? null,
      userId: request.user?.id ?? null,
      visitorId: request.header(VISITOR_ID_HEADER) ?? null,
    };
  },
  customReceivedMessage: () => "request received",
  customSuccessMessage: () => "request completed",
  genReqId: (req, res) => {
    const request = req as Request;
    const requestId = getRequestId(request);
    res.setHeader("x-request-id", requestId);
    return requestId;
  },
  logger,
});
