import process from "node:process";
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { VISITOR_ID_HEADER } from "@shared/visitor";
import { runStartupMaintenance } from "./maintenance";
import { getLogger } from "./observability/logger";
import { initSentry, captureException } from "./observability/sentry";
import { validateRuntimeConfig } from "./runtime-config";

try { (process as NodeJS.Process & { loadEnvFile?: () => void }).loadEnvFile?.(); } catch { /* no .env file in production */ }

const app = express();
const httpServer = createServer(app);
const appLogger = getLogger({ component: "api" });

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

(async () => {
  initSentry("convertflow-api");
  validateRuntimeConfig("api");

  const maintenance = await runStartupMaintenance();
  if (maintenance.recovered > 0) {
    appLogger.info({ recovered: maintenance.recovered }, "Marked stuck jobs as failed");
  }
  if (maintenance.cleaned > 0) {
    appLogger.info({ cleaned: maintenance.cleaned }, "Deleted expired jobs");
  }

  await registerRoutes(httpServer, app);

  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    const requestLogger = req.log ?? appLogger;
    requestLogger.error({
      err,
      requestId: req.id ?? null,
      status,
    }, "Unhandled request error");
    captureException(err, {
      contexts: {
        request: {
          method: req.method,
          path: req.originalUrl,
          requestId: req.id ?? null,
          status,
          userId: req.user?.id ?? null,
          visitorId: req.header(VISITOR_ID_HEADER) ?? null,
        },
      },
      tags: {
        component: "api",
      },
    });

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "3000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
    },
    () => {
      appLogger.info({ port }, "HTTP server listening");
    },
  );
})().catch((error) => {
  appLogger.error({ err: error }, "API server failed to start");
  captureException(error, {
    tags: {
      component: "api",
    },
  });
  process.exit(1);
});
