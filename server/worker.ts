import process from "node:process";
import { runStartupMaintenance } from "./maintenance";
import { startQueueWorkerRuntime } from "./queue";

try { (process as NodeJS.Process & { loadEnvFile?: () => void }).loadEnvFile?.(); } catch { /* no .env file in production */ }

function log(message: string) {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    hour12: true,
    minute: "2-digit",
    second: "2-digit",
  });

  console.log(`${formattedTime} [worker] ${message}`);
}

async function main() {
  const maintenance = await runStartupMaintenance();

  if (maintenance.recovered > 0) {
    log(`marked ${maintenance.recovered} stuck job(s) as failed`);
  }

  if (maintenance.cleaned > 0) {
    log(`deleted ${maintenance.cleaned} expired job(s)`);
  }

  const runtime = await startQueueWorkerRuntime({
    onError: (error) => {
      console.error("Queue worker failed:", error);
    },
  });

  log(`started ${runtime.kind} worker runtime`);

  const shutdown = async (signal: string) => {
    log(`received ${signal}, stopping worker`);
    await runtime.stop();
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
  console.error("Worker failed to start:", error);
  process.exit(1);
});
