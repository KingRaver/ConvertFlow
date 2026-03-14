import process from "node:process";
import { runStartupMaintenance } from "./maintenance";
import { startQueueWorkerRuntime } from "./queue";
import { getLogger } from "./observability/logger";
import { captureException, flushSentry, initSentry } from "./observability/sentry";

try { (process as NodeJS.Process & { loadEnvFile?: () => void }).loadEnvFile?.(); } catch { /* no .env file in production */ }

const workerLogger = getLogger({ component: "worker" });

async function main() {
  initSentry("convertflow-worker");
  const maintenance = await runStartupMaintenance();

  if (maintenance.recovered > 0) {
    workerLogger.info({ recovered: maintenance.recovered }, "Marked stuck jobs as failed");
  }

  if (maintenance.cleaned > 0) {
    workerLogger.info({ cleaned: maintenance.cleaned }, "Deleted expired jobs");
  }

  const runtime = await startQueueWorkerRuntime({
    onError: (error) => {
      workerLogger.error({ err: error }, "Queue worker failed");
      captureException(error, {
        tags: {
          component: "worker",
        },
      });
    },
  });

  workerLogger.info({ runtime: runtime.kind }, "Queue worker runtime started");

  const shutdown = async (signal: string) => {
    workerLogger.info({ signal }, "Stopping worker");
    await runtime.stop();
    await flushSentry();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

void main().catch((error) => {
  workerLogger.error({ err: error }, "Worker failed to start");
  captureException(error, {
    tags: {
      component: "worker",
    },
  });
  process.exit(1);
});
