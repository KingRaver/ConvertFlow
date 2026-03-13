import type { Server } from "node:http";
import process from "node:process";
import { PgBoss, type QueueOptions } from "pg-boss";
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

type QueueJobName =
  | (typeof CONVERSION_QUEUE_NAMES)[ConverterFamily]
  | typeof EXPIRY_QUEUE_NAME
  | typeof EXPIRY_SWEEP_QUEUE_NAME;

interface QueueSendOptions {
  id?: string;
  startAfter?: Date;
}

interface QueueStartOptions {
  embeddedWorker?: boolean;
  onError?: (error: unknown) => void;
}

interface QueueRuntime {
  readonly kind: "memory" | "pg-boss";
  startServer(options: QueueStartOptions): Promise<void>;
  startWorker(options: QueueStartOptions): Promise<void>;
  enqueueConversionJob(payload: ConversionJobPayload): Promise<void>;
  scheduleExpiryJob(payload: ExpiryJobPayload, runAt: Date): Promise<void>;
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

function defaultQueueErrorHandler(error: unknown) {
  console.error("Queue runtime failed:", error);
}

function shouldEmbedWorker() {
  const configured = process.env.EMBEDDED_CONVERSION_WORKER?.trim().toLowerCase();

  if (configured === "true") {
    return true;
  }

  if (configured === "false") {
    return false;
  }

  return !databaseUrl || process.env.NODE_ENV !== "production";
}

class MemoryQueueRuntime implements QueueRuntime {
  readonly kind = "memory" as const;

  private onError: (error: unknown) => void = defaultQueueErrorHandler;
  private queues = new Map<QueueJobName, unknown[]>();
  private workers = new Map<QueueJobName, { active: number; concurrency: number; handler: QueueHandler<any> }>();
  private delayedJobs = new Map<string, NodeJS.Timeout>();
  private expirySweepTimer: NodeJS.Timeout | null = null;
  private workersStarted = false;

  async startServer(options: QueueStartOptions) {
    this.onError = options.onError ?? this.onError;

    if (options.embeddedWorker ?? true) {
      this.startWorkers();
    }

    this.startExpirySweep();
  }

  async startWorker(options: QueueStartOptions) {
    this.onError = options.onError ?? this.onError;
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

  async stop() {
    if (this.expirySweepTimer) {
      clearInterval(this.expirySweepTimer);
      this.expirySweepTimer = null;
    }

    for (const timer of Array.from(this.delayedJobs.values())) {
      clearTimeout(timer);
    }

    this.delayedJobs.clear();
    this.queues.clear();
    this.workers.clear();
    this.workersStarted = false;
  }

  private startWorkers() {
    if (this.workersStarted) {
      return;
    }

    for (const [family, concurrency] of Object.entries(FAMILY_CONCURRENCY) as Array<
      [ConverterFamily, number]
    >) {
      this.registerWorker(getQueueNameForFamily(family), concurrency, processQueuedConversion);
    }

    this.registerWorker(EXPIRY_QUEUE_NAME, 1, async (payload: ExpiryJobPayload) => {
      await expireConversionById(payload);
    });
    this.registerWorker(EXPIRY_SWEEP_QUEUE_NAME, 1, async () => {
      await cleanupExpiredConversions();
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
      const delayMs = Math.max(0, options.startAfter.getTime() - Date.now());
      const timer = setTimeout(() => {
        if (options.id) {
          this.delayedJobs.delete(options.id);
        }

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
      id: `conversion-expiry-${payload.conversionId}`,
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
          await Promise.all(jobs.map((job) => processQueuedConversion(job.data)));
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

    this.workersStarted = true;
  }
}

const queueRuntime: QueueRuntime = databaseUrl
  ? new PgBossQueueRuntime()
  : new MemoryQueueRuntime();

export async function startQueueServerRuntime(httpServer: Server, options?: QueueStartOptions) {
  ensureWorkingDirectories();

  const embeddedWorker = queueRuntime.kind === "memory"
    ? true
    : options?.embeddedWorker ?? shouldEmbedWorker();

  await queueRuntime.startServer({
    embeddedWorker,
    onError: options?.onError,
  });

  httpServer.once("close", () => {
    void queueRuntime.stop().catch((error) => {
      (options?.onError ?? defaultQueueErrorHandler)(error);
    });
  });

  return {
    embeddedWorker,
    kind: queueRuntime.kind,
  };
}

export async function startQueueWorkerRuntime(options?: QueueStartOptions) {
  ensureWorkingDirectories();

  await queueRuntime.startWorker({
    embeddedWorker: true,
    onError: options?.onError,
  });

  return {
    kind: queueRuntime.kind,
    stop: () => queueRuntime.stop(),
  };
}

export async function enqueueConversionJob(payload: ConversionJobPayload) {
  await queueRuntime.enqueueConversionJob(payload);
}

export async function scheduleConversionExpiryJob(
  payload: ExpiryJobPayload,
  runAt: Date,
) {
  await queueRuntime.scheduleExpiryJob(payload, runAt);
}
