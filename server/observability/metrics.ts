import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

export interface QueueMetricSample {
  activeWorkers: number;
  depth: number;
  queueName: string;
  runtime: "memory" | "pg-boss";
}

const register = new Registry();

collectDefaultMetrics({
  register,
});

const conversionCounter = new Counter({
  help: "Completed conversion jobs partitioned by route and terminal status.",
  labelNames: ["route", "status"] as const,
  name: "convertflow_conversion_total",
  registers: [register],
});

const processingDurationHistogram = new Histogram({
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  help: "Conversion processing duration in seconds by route.",
  labelNames: ["route"] as const,
  name: "convertflow_conversion_processing_duration_seconds",
  registers: [register],
});

const fileSizeHistogram = new Histogram({
  buckets: [
    1_024,
    10_240,
    102_400,
    1_048_576,
    10_485_760,
    52_428_800,
    104_857_600,
    524_288_000,
  ],
  help: "Observed conversion file sizes in bytes.",
  labelNames: ["direction", "route"] as const,
  name: "convertflow_file_size_bytes",
  registers: [register],
});

const queueDepthGauge = new Gauge({
  help: "Queued and deferred jobs waiting in each queue.",
  labelNames: ["queue", "runtime"] as const,
  name: "convertflow_queue_depth",
  registers: [register],
});

const activeWorkerGauge = new Gauge({
  help: "Currently active workers per queue.",
  labelNames: ["queue", "runtime"] as const,
  name: "convertflow_active_workers",
  registers: [register],
});

export function getMetricsContentType() {
  return register.contentType;
}

export async function renderMetrics() {
  return register.metrics();
}

export function recordConversionResult(input: {
  durationMs: number;
  inputBytes?: number | null;
  outputBytes?: number | null;
  route: string;
  status: "completed" | "failed";
}) {
  conversionCounter.labels(input.route, input.status).inc();
  processingDurationHistogram.labels(input.route).observe(input.durationMs / 1_000);

  if (typeof input.inputBytes === "number" && Number.isFinite(input.inputBytes)) {
    fileSizeHistogram.labels("input", input.route).observe(input.inputBytes);
  }

  if (typeof input.outputBytes === "number" && Number.isFinite(input.outputBytes)) {
    fileSizeHistogram.labels("output", input.route).observe(input.outputBytes);
  }
}

export function setQueueMetrics(samples: QueueMetricSample[]) {
  for (const sample of samples) {
    queueDepthGauge.labels(sample.queueName, sample.runtime).set(sample.depth);
    activeWorkerGauge.labels(sample.queueName, sample.runtime).set(sample.activeWorkers);
  }
}
