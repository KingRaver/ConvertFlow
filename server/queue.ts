import type { Server } from "node:http";
import process from "node:process";
import { PgBoss, type QueueOptions } from "pg-boss";
import type { Conversion, WebhookEventType } from "@shared/schema";
import type { ConverterFamily } from "./converters";
import { registry } from "./converters/registry";
import { CONVERTER_TIMEOUT_MS } from "./converters/runtime";
import {
  type ConversionJobPayload,
  type ExpiryJobPayload,
  expireConversionById,
  processQueuedConversion,
} from "./conversion-jobs";
import { databaseUrl } from "./db";
import { ensureWorkingDirectories } from "./files";
import { cleanupExpiredConversions } from "./maintenance";
import { getStorage } from "./storage";
import { type WebhookDeliveryPayload, processWebhookDelivery } from "./webhooks";
import { getLogger } from "./observability/logger";
import { captureException } from "./observability/sentry";
import { resolveRuntimeConfig, validateRuntimeConfig, type QueueRuntimeKind } from "./runtime-config";

const QUEUE_JOB_TIMEOUT_SECONDS = Math.ceil(CONVERTER_TIMEOUT_MS / 1000);
const EXPIRY_SWEEP_INTERVAL_CRON = "*/10 * * * *";
const EXPIRY_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const EXPIRY_SWEEP_KEY = "convertflow-expiry-sweep";

const FAMILY_CONCURRENCY: Record<ConverterFamily, number> = {
  audio: 2,
  data: 2,
  document: 2,
  image: 4,
  video: 1,
};

const CONVERSION_QUEUE_NAMES: Record<ConverterFamily, string> = {
  audio: "conversion-audio",
  data: "conversion-data",
  document: "conversion-document",
  image: "conversion-image",
  video: "conversion-video",
};

const EXPIRY_QUEUE_NAME = "conversion-expiry";
const EXPIRY_SWEEP_QUEUE_NAME = "conversion-expiry-sweep";
const WEBHOOK_QUEUE_NAME = "webhook-delivery";
const queueLogger = getLogger({ component: "queue" });

type QueueJobName =
  | (typeof CONVERSION_QUEUE_NAMES)[ConverterFamily]
  | typeof EXPIRY_QUEUE_NAME
  | typeof EXPIRY_SWEEP_QUEUE_NAME
  | typeof WEBHOOK_QUEUE_NAME;

const ALL_QUEUE_NAMES: QueueJobName[] = [
  ...Object.values(CONVERSION_QUEUE_NAMES),
  EXPIRY_QUEUE_NAME,
  EXPIRY_SWEEP_QUEUE_NAME,
  WEBHOOK_QUEUE_NAME,
];

interface QueueSendOptions {
  id?: string;
  startAfter?: Date;
}

interface QueueStartOptions {
  embeddedWorker?: boolean;
  onError?: (error: unknown) => void;
}

export interface QueueMetricSample {
  activeWorkers: number;
  depth: number;
  queueName: QueueJobName;
  runtime: "memory" | "pg-boss";
}

interface QueueRuntime {
  readonly kind: "memory" | "pg-boss";
  startServer(options: QueueStartOptions): Promise<void>;
  startWorker(options: QueueStartOptions): Promise<void>;
  enqueueConversionJob(payload: ConversionJobPayload): Promise<void>;
  scheduleExpiryJob(payload: ExpiryJobPayload, runAt: Date): Promise<void>;
  scheduleWebhookDeliveryJob(payload: WebhookDeliveryPayload, runAt?: Date): Promise<void>;
  getHealthStatus(): Promise<boolean>;
  getMetricSamples(): Promise<QueueMetricSample[]>;
  stop(): Promise<void>;
}

type QueueHandler<T> = (payload: T) => Promise<void>;

function getQueueNameForFamily(family: ConverterFamily) {
  return CONVERSION_QUEUE_NAMES[family];
}

function getQueueNameForConversion(payload: ConversionJobPayload) {
  return getQueueNameForFamily(
    registry.getAdapter(payload.sourceFormat, payload.targetFormat).family,
  );
}

async function enqueueWebhookJobsForConversion(
  conversion: Conversion,
  event: WebhookEventType,
) {
  if (conversion.userId === null) {
    return;
  }

  const matchingWebhooks = await getStorage().listWebhooksForEvent(conversion.userId, event);
  await Promise.all(matchingWebhooks.map((webhook) => getQueueRuntime().scheduleWebhookDeliveryJob({
    attempt: 0,
    conversionId: conversion.id,
    event,
    webhookId: webhook.id,
  })));
}

function defaultQueueErrorHandler(error: unknown) {
  queueLogger.error({ err: error }, "Queue runtime failed");
  captureException(error, {
    contexts: {
      queue: {
        runtime: getQueueRuntime().kind,
      },
    },
    tags: {
      component: "queue",
    },
  });
}

export function resolveEmbeddedWorkerSetting(
  env: NodeJS.ProcessEnv = process.env,
  runtime: QueueRuntimeKind = resolveRuntimeConfig(env).queueRuntime,
) {
  if (runtime === "memory") {
    return true;
  }

  const configured = env.EMBEDDED_CONVERSION_WORKER?.trim().toLowerCase();

  if (configured === "true") {
    return true;
  }

  if (configured === "false") {
    return false;
  }

  return true;
}

class MemoryQueueRuntime implements QueueRuntime {
  readonly kind = "memory" as const;

  private onError: (error: unknown) => void = defaultQueueErrorHandler;
  private queues = new Map<QueueJobName, unknown[]>();
  private workers = new Map<QueueJobName, { active: number; concurrency: number; handler: QueueHandler<any> }>();
  private delayedJobs = new Map<string, NodeJS.Timeout>();
  private delayedQueueDepth = new Map<QueueJobName, number>();
  private expirySweepTimer: NodeJS.Timeout | null = null;
  private started = false;
  private workersStarted = false;

  async startServer(options: QueueStartOptions) {
    this.onError = options.onError ?? this.onError;
    this.started = true;

    if (options.embeddedWorker ?? true) {
      this.startWorkers();
    }

    this.startExpirySweep();
  }

  async startWorker(options: QueueStartOptions) {
    this.onError = options.onError ?? this.onError;
    this.started = true;
    this.startWorkers();
    this.startExpirySweep();
  }

  async enqueueConversionJob(payload: ConversionJobPayload) {
    this.enqueue(getQueueNameForConversion(payload), payload);
  }

  async scheduleExpiryJob(payload: ExpiryJobPayload, runAt: Date) {
    this.enqueue(EXPIRY_QUEUE_NAME, payload, {
      id: `conversion-expiry-${payload.conversionId}`,
      startAfter: runAt,
    });
  }

  async scheduleWebhookDeliveryJob(payload: WebhookDeliveryPayload, runAt?: Date) {
    this.enqueue(WEBHOOK_QUEUE_NAME, payload, {
      id: `webhook-delivery-${payload.webhookId}-${payload.conversionId}-${payload.event}-${payload.attempt}`,
      startAfter: runAt,
    });
  }

  async stop() {
    if (this.expirySweepTimer) {
      clearInterval(this.expirySweepTimer);
      this.expirySweepTimer = null;
    }

    for (const timer of Array.from(this.delayedJobs.values())) {
      clearTimeout(timer);
    }

    this.delayedJobs.clear();
    this.delayedQueueDepth.clear();
    this.queues.clear();
    this.workers.clear();
    this.started = false;
    this.workersStarted = false;
  }

  async getHealthStatus() {
    return this.started;
  }

  async getMetricSamples() {
    return ALL_QUEUE_NAMES.map((queueName) => ({
      activeWorkers: this.workers.get(queueName)?.active ?? 0,
      depth: (this.queues.get(queueName)?.length ?? 0) + (this.delayedQueueDepth.get(queueName) ?? 0),
      queueName,
      runtime: this.kind,
    }));
  }

  private startWorkers() {
    if (this.workersStarted) {
      return;
    }

    for (const [family, concurrency] of Object.entries(FAMILY_CONCURRENCY) as Array<
      [ConverterFamily, number]
    >) {
      this.registerWorker(getQueueNameForFamily(family), concurrency, async (payload: ConversionJobPayload) => {
        await processQueuedConversion(payload, {
          onSettled: enqueueWebhookJobsForConversion,
        });
      });
    }

    this.registerWorker(EXPIRY_QUEUE_NAME, 1, async (payload: ExpiryJobPayload) => {
      await expireConversionById(payload);
    });
    this.registerWorker(EXPIRY_SWEEP_QUEUE_NAME, 1, async () => {
      await cleanupExpiredConversions();
    });
    this.registerWorker(WEBHOOK_QUEUE_NAME, 4, async (payload: WebhookDeliveryPayload) => {
      const result = await processWebhookDelivery(payload);
      if (!result.retryAt) {
        return;
      }

      await this.scheduleWebhookDeliveryJob({
        ...payload,
        attempt: payload.attempt + 1,
      }, result.retryAt);
    });

    this.workersStarted = true;
  }

  private startExpirySweep() {
    if (this.expirySweepTimer) {
      return;
    }

    this.expirySweepTimer = setInterval(() => {
      this.enqueue(EXPIRY_SWEEP_QUEUE_NAME, {});
    }, EXPIRY_SWEEP_INTERVAL_MS);

    this.expirySweepTimer.unref?.();
  }

  private registerWorker<T>(
    queueName: QueueJobName,
    concurrency: number,
    handler: QueueHandler<T>,
  ) {
    this.workers.set(queueName, {
      active: 0,
      concurrency,
      handler,
    });
    this.processQueue(queueName);
  }

  private enqueue(
    queueName: QueueJobName,
    payload: unknown,
    options?: QueueSendOptions,
  ) {
    if (options?.id && this.delayedJobs.has(options.id)) {
      return;
    }

    if (options?.startAfter && options.startAfter.getTime() > Date.now()) {
      this.incrementDelayedQueueDepth(queueName);
      const delayMs = Math.max(0, options.startAfter.getTime() - Date.now());
      const timer = setTimeout(() => {
        if (options.id) {
          this.delayedJobs.delete(options.id);
        }
        this.decrementDelayedQueueDepth(queueName);

        this.enqueueNow(queueName, payload);
      }, delayMs);

      timer.unref?.();

      if (options.id) {
        this.delayedJobs.set(options.id, timer);
      }

      return;
    }

    this.enqueueNow(queueName, payload);
  }

  private incrementDelayedQueueDepth(queueName: QueueJobName) {
    this.delayedQueueDepth.set(queueName, (this.delayedQueueDepth.get(queueName) ?? 0) + 1);
  }

  private decrementDelayedQueueDepth(queueName: QueueJobName) {
    const nextValue = (this.delayedQueueDepth.get(queueName) ?? 0) - 1;
    if (nextValue <= 0) {
      this.delayedQueueDepth.delete(queueName);
      return;
    }

    this.delayedQueueDepth.set(queueName, nextValue);
  }

  private enqueueNow(queueName: QueueJobName, payload: unknown) {
    const queue = this.queues.get(queueName) ?? [];
    queue.push(payload);
    this.queues.set(queueName, queue);
    this.processQueue(queueName);
  }

  private processQueue(queueName: QueueJobName) {
    const worker = this.workers.get(queueName);
    const queue = this.queues.get(queueName);

    if (!worker || !queue) {
      return;
    }

    while (worker.active < worker.concurrency && queue.length > 0) {
      const payload = queue.shift();
      worker.active += 1;

      void Promise.resolve()
        .then(() => worker.handler(payload))
        .catch((error) => {
          this.onError(error);
        })
        .finally(() => {
          worker.active -= 1;
          this.processQueue(queueName);
        });
    }
  }
}

class PgBossQueueRuntime implements QueueRuntime {
  readonly kind = "pg-boss" as const;

  private onError: (error: unknown) => void = defaultQueueErrorHandler;
  private boss: PgBoss | null = null;
  private starting: Promise<PgBoss> | null = null;
  private workersStarted = false;
  private sweepScheduled = false;

  async startServer(options: QueueStartOptions) {
    this.onError = options.onError ?? this.onError;

    await this.ensureBoss();
    await this.scheduleSweep();

    if (options.embeddedWorker) {
      await this.startWorkers();
    }
  }

  async startWorker(options: QueueStartOptions) {
    this.onError = options.onError ?? this.onError;

    await this.ensureBoss();
    await this.scheduleSweep();
    await this.startWorkers();
  }

  async enqueueConversionJob(payload: ConversionJobPayload) {
    const boss = await this.ensureBoss();

    await boss.send(getQueueNameForConversion(payload), payload, {
      expireInSeconds: QUEUE_JOB_TIMEOUT_SECONDS,
      retryLimit: 0,
    });
  }

  async scheduleExpiryJob(payload: ExpiryJobPayload, runAt: Date) {
    const boss = await this.ensureBoss();

    await boss.send(EXPIRY_QUEUE_NAME, payload, {
      expireInSeconds: QUEUE_JOB_TIMEOUT_SECONDS,
      singletonKey: `conversion-expiry-${payload.conversionId}`,
      retryLimit: 0,
      startAfter: runAt,
    });
  }

  async scheduleWebhookDeliveryJob(payload: WebhookDeliveryPayload, runAt?: Date) {
    const boss = await this.ensureBoss();

    await boss.send(WEBHOOK_QUEUE_NAME, payload, {
      expireInSeconds: QUEUE_JOB_TIMEOUT_SECONDS,
      id: `webhook-delivery-${payload.webhookId}-${payload.conversionId}-${payload.event}-${payload.attempt}`,
      retryLimit: 0,
      startAfter: runAt,
    });
  }

  async stop() {
    const boss = this.boss;

    this.boss = null;
    this.starting = null;
    this.workersStarted = false;
    this.sweepScheduled = false;

    if (!boss) {
      return;
    }

    await boss.stop({ close: true, graceful: true });
  }

  async getHealthStatus() {
    if (!this.boss && !this.starting) {
      return false;
    }

    const boss = await this.ensureBoss();
    await Promise.all(ALL_QUEUE_NAMES.map((queueName) => boss.getQueue(queueName)));
    return true;
  }

  async getMetricSamples() {
    const boss = await this.ensureBoss();

    return Promise.all(ALL_QUEUE_NAMES.map(async (queueName) => {
      const stats = await boss.getQueueStats(queueName);
      return {
        activeWorkers: stats.activeCount,
        depth: stats.queuedCount + stats.deferredCount,
        queueName,
        runtime: this.kind,
      };
    }));
  }

  private async ensureBoss() {
    if (this.boss) {
      return this.boss;
    }

    if (this.starting) {
      return this.starting;
    }

    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required to use the pg-boss queue runtime.");
    }

    this.starting = (async () => {
      const boss = new PgBoss({
        application_name: "convertflow-queue",
        connectionString: databaseUrl,
      });

      boss.on("error", (error) => {
        this.onError(error);
      });

      await boss.start();
      await this.ensureQueues(boss);

      this.boss = boss;
      this.starting = null;
      return boss;
    })().catch((error) => {
      this.starting = null;
      throw error;
    });

    return this.starting;
  }

  private async ensureQueues(boss: PgBoss) {
    const queueOptions: QueueOptions = {
      deleteAfterSeconds: 60 * 60,
      expireInSeconds: QUEUE_JOB_TIMEOUT_SECONDS,
      retryLimit: 0,
    };

    const queueEntries = [
      ...Object.values(CONVERSION_QUEUE_NAMES),
      EXPIRY_QUEUE_NAME,
      EXPIRY_SWEEP_QUEUE_NAME,
      WEBHOOK_QUEUE_NAME,
    ];

    for (const queueName of queueEntries) {
      const existing = await boss.getQueue(queueName);

      if (!existing) {
        await boss.createQueue(queueName, queueOptions);
        continue;
      }

      await boss.updateQueue(queueName, queueOptions);
    }
  }

  private async scheduleSweep() {
    if (this.sweepScheduled) {
      return;
    }

    const boss = await this.ensureBoss();

    await boss.schedule(
      EXPIRY_SWEEP_QUEUE_NAME,
      EXPIRY_SWEEP_INTERVAL_CRON,
      {},
      {
        expireInSeconds: QUEUE_JOB_TIMEOUT_SECONDS,
        key: EXPIRY_SWEEP_KEY,
        retryLimit: 0,
      },
    );

    this.sweepScheduled = true;
  }

  private async startWorkers() {
    if (this.workersStarted) {
      return;
    }

    const boss = await this.ensureBoss();

    for (const [family, concurrency] of Object.entries(FAMILY_CONCURRENCY) as Array<
      [ConverterFamily, number]
    >) {
      await boss.work<ConversionJobPayload>(
        getQueueNameForFamily(family),
        {
          batchSize: 1,
          localConcurrency: concurrency,
          pollingIntervalSeconds: 1,
        },
        async (jobs) => {
          await Promise.all(jobs.map((job) => processQueuedConversion(job.data, {
            onSettled: enqueueWebhookJobsForConversion,
          })));
        },
      );
    }

    await boss.work<ExpiryJobPayload>(
      EXPIRY_QUEUE_NAME,
      {
        batchSize: 1,
        localConcurrency: 1,
        pollingIntervalSeconds: 1,
      },
      async (jobs) => {
        await Promise.all(jobs.map((job) => expireConversionById(job.data)));
      },
    );

    await boss.work<Record<string, never>>(
      EXPIRY_SWEEP_QUEUE_NAME,
      {
        batchSize: 1,
        localConcurrency: 1,
        pollingIntervalSeconds: 1,
      },
      async (jobs) => {
        if (jobs.length === 0) {
          return;
        }

        await cleanupExpiredConversions();
      },
    );

    await boss.work<WebhookDeliveryPayload>(
      WEBHOOK_QUEUE_NAME,
      {
        batchSize: 1,
        localConcurrency: 4,
        pollingIntervalSeconds: 1,
      },
      async (jobs) => {
        await Promise.all(jobs.map(async (job) => {
          const result = await processWebhookDelivery(job.data);
          if (!result.retryAt) {
            return;
          }

          await this.scheduleWebhookDeliveryJob({
            ...job.data,
            attempt: job.data.attempt + 1,
          }, result.retryAt);
        }));
      },
    );

    this.workersStarted = true;
  }
}

let _queueRuntime: QueueRuntime | null = null;

function getQueueRuntime(): QueueRuntime {
  if (!_queueRuntime) {
    validateRuntimeConfig();
    _queueRuntime = resolveRuntimeConfig().queueRuntime === "pg-boss"
      ? new PgBossQueueRuntime()
      : new MemoryQueueRuntime();
  }

  return _queueRuntime;
}

export function getQueueRuntimeKind(): QueueRuntimeKind {
  return resolveRuntimeConfig().queueRuntime;
}

export async function startQueueServerRuntime(httpServer: Server, options?: QueueStartOptions) {
  ensureWorkingDirectories();

  const runtime = getQueueRuntime();
  const embeddedWorker = options?.embeddedWorker ?? resolveEmbeddedWorkerSetting(process.env, runtime.kind);

  await runtime.startServer({
    embeddedWorker,
    onError: options?.onError,
  });

  queueLogger.info({ embeddedWorker, runtime: runtime.kind }, "Queue server runtime started");

  if (!embeddedWorker) {
    queueLogger.warn(
      { runtime: runtime.kind },
      "Embedded conversion worker disabled; ensure a standalone worker process is running",
    );
  }

  httpServer.once("close", () => {
    void getQueueRuntime().stop().catch((error: unknown) => {
      (options?.onError ?? defaultQueueErrorHandler)(error);
    });
  });

  return {
    embeddedWorker,
    kind: runtime.kind,
  };
}

export async function startQueueWorkerRuntime(options?: QueueStartOptions) {
  ensureWorkingDirectories();

  await getQueueRuntime().startWorker({
    embeddedWorker: true,
    onError: options?.onError,
  });

  return {
    kind: getQueueRuntime().kind,
    stop: () => getQueueRuntime().stop(),
  };
}

export async function enqueueConversionJob(payload: ConversionJobPayload) {
  await getQueueRuntime().enqueueConversionJob(payload);
}

export async function scheduleConversionExpiryJob(
  payload: ExpiryJobPayload,
  runAt: Date,
) {
  await getQueueRuntime().scheduleExpiryJob(payload, runAt);
}

export async function scheduleWebhookDeliveryJob(
  payload: WebhookDeliveryPayload,
  runAt?: Date,
) {
  await getQueueRuntime().scheduleWebhookDeliveryJob(payload, runAt);
}

export async function getQueueMetricSamples() {
  return getQueueRuntime().getMetricSamples();
}

export async function getQueueHealthStatus() {
  return getQueueRuntime().getHealthStatus();
}
