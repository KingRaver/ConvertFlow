import process from "node:process";
import * as Sentry from "@sentry/node";
import { logger } from "./logger";

interface CaptureContext {
  contexts?: Record<string, Record<string, unknown>>;
  extras?: Record<string, unknown>;
  tags?: Record<string, string>;
}

let sentryInitialized = false;
let rejectionHandlerAttached = false;
let uncaughtHandlerAttached = false;

function normalizeError(error: unknown) {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === "string") {
    return new Error(error);
  }

  return new Error("Unknown error");
}

export function initSentry(service: string) {
  const dsn = process.env.SENTRY_DSN?.trim();

  if (!dsn || sentryInitialized) {
    return false;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "development",
    initialScope: {
      tags: {
        service,
      },
    },
  });

  if (!rejectionHandlerAttached) {
    process.on("unhandledRejection", (reason) => {
      captureException(reason, {
        contexts: {
          runtime: {
            event: "unhandledRejection",
            service,
          },
        },
      });
    });
    rejectionHandlerAttached = true;
  }

  if (!uncaughtHandlerAttached) {
    process.on("uncaughtExceptionMonitor", (error) => {
      captureException(error, {
        contexts: {
          runtime: {
            event: "uncaughtException",
            service,
          },
        },
      });
    });
    uncaughtHandlerAttached = true;
  }

  sentryInitialized = true;
  logger.info({ service }, "Sentry initialized");
  return true;
}

export function captureException(error: unknown, context?: CaptureContext) {
  const normalizedError = normalizeError(error);

  if (sentryInitialized) {
    Sentry.withScope((scope) => {
      for (const [key, value] of Object.entries(context?.tags ?? {})) {
        scope.setTag(key, value);
      }

      for (const [key, value] of Object.entries(context?.extras ?? {})) {
        scope.setExtra(key, value);
      }

      for (const [key, value] of Object.entries(context?.contexts ?? {})) {
        scope.setContext(key, value);
      }

      Sentry.captureException(normalizedError);
    });
  }

  return normalizedError;
}

export async function flushSentry(timeoutMs = 2_000) {
  if (!sentryInitialized) {
    return true;
  }

  return Sentry.flush(timeoutMs);
}
