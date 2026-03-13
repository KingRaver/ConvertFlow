import type {
  ApiKey,
  Batch,
  BatchStatus,
  Conversion,
  ConversionStatus,
  IdempotencyKey,
  InsertApiKey,
  InsertBatch,
  InsertConversion,
  InsertIdempotencyKey,
  InsertPreset,
  InsertSession,
  InsertUser,
  InsertUsageEvent,
  InsertWebhook,
  Preset,
  Session,
  User,
  UsageEvent,
  UsageEventType,
  Webhook,
  WebhookEventType,
} from "@shared/schema";
import { hasDatabaseUrl } from "./db";
import { DrizzleStorage } from "./storage/drizzle";

export interface ConversionListOptions {
  format?: string;
  limit: number;
  page: number;
  status?: ConversionStatus;
  userId?: number;
  visitorId?: string;
}

export interface PaginatedConversions {
  items: Conversion[];
  limit: number;
  page: number;
  total: number;
}

export type IdempotencyScope =
  | { userId: number; visitorId?: never }
  | { userId?: never; visitorId: string };

export interface IStorage {
  createBatch(batch: InsertBatch): Promise<Batch>;
  createBatchWithConversions(
    batch: InsertBatch,
    conversions: Array<Omit<InsertConversion, "batchId">>,
  ): Promise<{ batch: Batch; conversions: Conversion[] }>;
  getBatch(id: number): Promise<Batch | undefined>;
  createConversion(conversion: InsertConversion): Promise<Conversion>;
  createPreset(preset: InsertPreset): Promise<Preset>;
  deleteBatch(id: number): Promise<void>;
  getConversion(id: number): Promise<Conversion | undefined>;
  getConversionByOutputFilename(outputFilename: string): Promise<Conversion | undefined>;
  getPreset(id: number): Promise<Preset | undefined>;
  listBatchConversions(batchId: number): Promise<Conversion[]>;
  updateConversion(id: number, updates: Partial<Conversion>): Promise<Conversion | undefined>;
  syncBatch(batchId: number): Promise<Batch | undefined>;
  listConversions(options: ConversionListOptions): Promise<PaginatedConversions>;
  listPresets(userId: number): Promise<Preset[]>;
  getExpiredConversions(now: Date): Promise<Conversion[]>;
  failStaleProcessingJobs(cutoff: Date, resultMessage: string): Promise<number>;
  deletePreset(id: number, userId: number): Promise<boolean>;
  deleteConversion(id: number): Promise<void>;
  createUser(user: InsertUser): Promise<User>;
  createUserWithSession(user: InsertUser, session: InsertSession): Promise<{ session: Session; user: User }>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserById(id: number): Promise<User | undefined>;
  updateUser(id: number, updates: Partial<User>): Promise<User | undefined>;
  createSession(session: InsertSession): Promise<Session>;
  getSessionByToken(token: string): Promise<Session | undefined>;
  deleteSessionByToken(token: string): Promise<void>;
  listApiKeys(userId: number): Promise<ApiKey[]>;
  createApiKey(apiKey: InsertApiKey): Promise<ApiKey>;
  getActiveApiKeyByHash(keyHash: string): Promise<ApiKey | undefined>;
  touchApiKeyLastUsed(id: number, lastUsedAt: Date): Promise<void>;
  revokeApiKey(id: number, userId: number, revokedAt?: Date): Promise<boolean>;
  createWebhook(webhook: InsertWebhook): Promise<Webhook>;
  getWebhook(id: number): Promise<Webhook | undefined>;
  listWebhooksForEvent(userId: number, event: WebhookEventType): Promise<Webhook[]>;
  deleteWebhook(id: number, userId: number): Promise<boolean>;
  createIdempotencyKey(key: InsertIdempotencyKey): Promise<IdempotencyKey>;
  getIdempotencyKey(keyHash: string, scope: IdempotencyScope, now?: Date): Promise<IdempotencyKey | undefined>;
  deleteExpiredIdempotencyKeys(now: Date): Promise<number>;
  createUsageEvent(event: InsertUsageEvent): Promise<UsageEvent>;
  countUsageEventsSince(userId: number, eventType: UsageEventType, since: Date): Promise<number>;
  countVisitorConversionsSince(visitorId: string, since: Date): Promise<number>;
}

function sortConversionsByNewest(left: Conversion, right: Conversion) {
  const createdDelta = (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0);
  if (createdDelta !== 0) {
    return createdDelta;
  }

  return right.id - left.id;
}

function matchesIdempotencyScope(record: IdempotencyKey, scope: IdempotencyScope) {
  if ("userId" in scope) {
    return record.userId === scope.userId;
  }

  return record.userId === null && record.visitorId === scope.visitorId;
}

function sortByCreatedAsc<T extends { createdAt: Date | null; id: number }>(left: T, right: T) {
  const createdDelta = (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0);
  if (createdDelta !== 0) {
    return createdDelta;
  }

  return left.id - right.id;
}

function sortByCreatedDesc<T extends { createdAt: Date | null; id: number }>(left: T, right: T) {
  const createdDelta = (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0);
  if (createdDelta !== 0) {
    return createdDelta;
  }

  return right.id - left.id;
}

function deriveBatchStatus(jobs: Conversion[], completedJobs: number, failedJobs: number): BatchStatus {
  const settledJobs = completedJobs + failedJobs;

  if (jobs.length === 0 || settledJobs === 0) {
    return jobs.some((job) => job.status === "processing") ? "processing" : "pending";
  }

  if (settledJobs < jobs.length) {
    return "processing";
  }

  if (failedJobs === 0) {
    return "completed";
  }

  if (completedJobs === 0) {
    return "failed";
  }

  return "partial";
}

function normalizeOptionsRecord(value: unknown) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return null;
  }

  return { ...(value as Record<string, unknown>) };
}

export class MemStorage implements IStorage {
  private apiKeys: Map<number, ApiKey>;
  private batches: Map<number, Batch>;
  private conversions: Map<number, Conversion>;
  private idempotencyKeys: Map<number, IdempotencyKey>;
  private nextApiKeyId: number;
  private nextBatchId: number;
  private nextConversionId: number;
  private nextIdempotencyKeyId: number;
  private nextPresetId: number;
  private nextSessionId: number;
  private nextUserId: number;
  private nextUsageEventId: number;
  private nextWebhookId: number;
  private presets: Map<number, Preset>;
  private sessions: Map<number, Session>;
  private usageEvents: Map<number, UsageEvent>;
  private users: Map<number, User>;
  private webhooks: Map<number, Webhook>;

  constructor() {
    this.apiKeys = new Map();
    this.batches = new Map();
    this.conversions = new Map();
    this.idempotencyKeys = new Map();
    this.presets = new Map();
    this.users = new Map();
    this.sessions = new Map();
    this.usageEvents = new Map();
    this.webhooks = new Map();
    this.nextApiKeyId = 1;
    this.nextBatchId = 1;
    this.nextConversionId = 1;
    this.nextIdempotencyKeyId = 1;
    this.nextPresetId = 1;
    this.nextUserId = 1;
    this.nextSessionId = 1;
    this.nextUsageEventId = 1;
    this.nextWebhookId = 1;
  }

  async createBatch(data: InsertBatch): Promise<Batch> {
    const id = this.nextBatchId++;
    const batch: Batch = {
      id,
      userId: data.userId,
      status: data.status ?? "pending",
      totalJobs: data.totalJobs,
      completedJobs: data.completedJobs,
      failedJobs: data.failedJobs,
      createdAt: new Date(),
    };

    this.batches.set(id, batch);
    return batch;
  }

  async getBatch(id: number): Promise<Batch | undefined> {
    return this.batches.get(id);
  }

  async createConversion(data: InsertConversion): Promise<Conversion> {
    const id = this.nextConversionId++;
    const conversion: Conversion = {
      id,
      originalName: data.originalName,
      originalFormat: data.originalFormat,
      targetFormat: data.targetFormat,
      inputKey: data.inputKey ?? null,
      status: data.status ?? "pending",
      fileSize: data.fileSize,
      convertedSize: data.convertedSize ?? null,
      outputFilename: data.outputFilename ?? null,
      resultMessage: data.resultMessage ?? null,
      visitorId: data.visitorId ?? null,
      userId: data.userId ?? null,
      batchId: data.batchId ?? null,
      presetId: data.presetId ?? null,
      options: normalizeOptionsRecord(data.options),
      processingStartedAt: data.processingStartedAt ?? null,
      engineUsed: data.engineUsed ?? null,
      createdAt: new Date(),
      expiresAt: data.expiresAt ?? null,
    };
    this.conversions.set(id, conversion);
    return conversion;
  }

  async createBatchWithConversions(
    batchData: InsertBatch,
    conversionList: Array<Omit<InsertConversion, "batchId">>,
  ): Promise<{ batch: Batch; conversions: Conversion[] }> {
    const batch = await this.createBatch(batchData);
    const conversions = await Promise.all(
      conversionList.map((conv) => this.createConversion({ ...conv, batchId: batch.id })),
    );
    return { batch, conversions };
  }

  async createPreset(data: InsertPreset): Promise<Preset> {
    const id = this.nextPresetId++;
    const preset: Preset = {
      id,
      userId: data.userId,
      name: data.name,
      sourceFormat: data.sourceFormat,
      targetFormat: data.targetFormat,
      options: normalizeOptionsRecord(data.options) ?? {},
      createdAt: new Date(),
    };

    this.presets.set(id, preset);
    return preset;
  }

  async getConversion(id: number): Promise<Conversion | undefined> {
    return this.conversions.get(id);
  }

  async getConversionByOutputFilename(outputFilename: string): Promise<Conversion | undefined> {
    return Array.from(this.conversions.values()).find(
      (conversion) => conversion.outputFilename === outputFilename,
    );
  }

  async getPreset(id: number): Promise<Preset | undefined> {
    return this.presets.get(id);
  }

  async listBatchConversions(batchId: number): Promise<Conversion[]> {
    return Array.from(this.conversions.values())
      .filter((conversion) => conversion.batchId === batchId)
      .sort(sortByCreatedAsc);
  }

  async updateConversion(id: number, updates: Partial<Conversion>): Promise<Conversion | undefined> {
    const existing = this.conversions.get(id);
    if (!existing) return undefined;

    const updated: Conversion = {
      ...existing,
      ...Object.fromEntries(
        Object.entries(updates).filter(([, value]) => value !== undefined),
      ),
    };

    this.conversions.set(id, updated);
    return updated;
  }

  async syncBatch(batchId: number): Promise<Batch | undefined> {
    const batch = this.batches.get(batchId);
    if (!batch) {
      return undefined;
    }

    const jobs = await this.listBatchConversions(batchId);
    if (jobs.length === 0) {
      this.batches.delete(batchId);
      return undefined;
    }

    const completedJobs = jobs.filter((job) => job.status === "completed").length;
    const failedJobs = jobs.filter((job) => job.status === "failed").length;
    const updated: Batch = {
      ...batch,
      status: deriveBatchStatus(jobs, completedJobs, failedJobs),
      totalJobs: jobs.length,
      completedJobs,
      failedJobs,
    };

    this.batches.set(batchId, updated);
    return updated;
  }

  async listConversions(options: ConversionListOptions): Promise<PaginatedConversions> {
    const filtered = Array.from(this.conversions.values())
      .filter((conversion) => {
        if (options.userId !== undefined) {
          return conversion.userId === options.userId;
        }

        if (options.visitorId !== undefined) {
          return conversion.visitorId === options.visitorId;
        }

        return false;
      })
      .filter((conversion) => {
        if (!options.status) {
          return true;
        }

        return conversion.status === options.status;
      })
      .filter((conversion) => {
        if (!options.format) {
          return true;
        }

        return (
          conversion.originalFormat === options.format ||
          conversion.targetFormat === options.format
        );
      })
      .sort(sortConversionsByNewest);

    const startIndex = (options.page - 1) * options.limit;
    const items = filtered.slice(startIndex, startIndex + options.limit);

    return {
      items,
      limit: options.limit,
      page: options.page,
      total: filtered.length,
    };
  }

  async getExpiredConversions(now: Date): Promise<Conversion[]> {
    return Array.from(this.conversions.values())
      .filter((conversion) => conversion.expiresAt !== null && conversion.expiresAt <= now)
      .sort((a, b) => (a.expiresAt?.getTime() ?? 0) - (b.expiresAt?.getTime() ?? 0));
  }

  async failStaleProcessingJobs(cutoff: Date, resultMessage: string): Promise<number> {
    let recoveredCount = 0;

    for (const conversion of Array.from(this.conversions.values())) {
      if (
        conversion.status === "processing" &&
        conversion.processingStartedAt !== null &&
        conversion.processingStartedAt < cutoff
      ) {
        this.conversions.set(conversion.id, {
          ...conversion,
          resultMessage,
          status: "failed",
        });
        recoveredCount += 1;
      }
    }

    return recoveredCount;
  }

  async deleteConversion(id: number): Promise<void> {
    this.conversions.delete(id);
  }

  async deleteBatch(id: number): Promise<void> {
    this.batches.delete(id);
  }

  async createUserWithSession(userData: InsertUser, sessionData: InsertSession): Promise<{ session: Session; user: User }> {
    const user = await this.createUser(userData);
    const session = await this.createSession({ ...sessionData, userId: user.id });
    return { session, user };
  }

  async createUser(data: InsertUser): Promise<User> {
    const id = this.nextUserId++;
    const user: User = {
      id,
      email: data.email,
      passwordHash: data.passwordHash,
      plan: data.plan ?? "free",
      role: data.role ?? "user",
      stripeCustomerId: data.stripeCustomerId ?? null,
      stripeSubscriptionId: data.stripeSubscriptionId ?? null,
      createdAt: new Date(),
    };

    this.users.set(id, user);
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find((user) => user.email === email);
  }

  async getUserById(id: number): Promise<User | undefined> {
    return this.users.get(id);
  }

  async updateUser(id: number, updates: Partial<User>): Promise<User | undefined> {
    const existing = this.users.get(id);
    if (!existing) {
      return undefined;
    }

    const updated: User = {
      ...existing,
      ...Object.fromEntries(
        Object.entries(updates).filter(([, value]) => value !== undefined),
      ),
    };

    this.users.set(id, updated);
    return updated;
  }

  async createSession(data: InsertSession): Promise<Session> {
    const id = this.nextSessionId++;
    const session: Session = {
      id,
      userId: data.userId,
      token: data.token,
      expiresAt: data.expiresAt,
      createdAt: new Date(),
    };

    this.sessions.set(id, session);
    return session;
  }

  async getSessionByToken(token: string): Promise<Session | undefined> {
    return Array.from(this.sessions.values()).find((session) => session.token === token);
  }

  async deleteSessionByToken(token: string): Promise<void> {
    const existing = Array.from(this.sessions.entries()).find(([, session]) => session.token === token);
    if (!existing) {
      return;
    }

    this.sessions.delete(existing[0]);
  }

  async listApiKeys(userId: number): Promise<ApiKey[]> {
    return Array.from(this.apiKeys.values())
      .filter((apiKey) => apiKey.userId === userId)
      .sort((left, right) => {
        const createdDelta = (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0);
        if (createdDelta !== 0) {
          return createdDelta;
        }

        return right.id - left.id;
      });
  }

  async createApiKey(data: InsertApiKey): Promise<ApiKey> {
    const id = this.nextApiKeyId++;
    const apiKey: ApiKey = {
      id,
      userId: data.userId,
      keyHash: data.keyHash,
      name: data.name,
      lastUsedAt: data.lastUsedAt ?? null,
      createdAt: new Date(),
      revokedAt: data.revokedAt ?? null,
    };

    this.apiKeys.set(id, apiKey);
    return apiKey;
  }

  async getActiveApiKeyByHash(keyHash: string): Promise<ApiKey | undefined> {
    return Array.from(this.apiKeys.values()).find((apiKey) => (
      apiKey.keyHash === keyHash &&
      apiKey.revokedAt === null
    ));
  }

  async touchApiKeyLastUsed(id: number, lastUsedAt: Date): Promise<void> {
    const apiKey = this.apiKeys.get(id);
    if (!apiKey) {
      return;
    }

    this.apiKeys.set(id, {
      ...apiKey,
      lastUsedAt,
    });
  }

  async revokeApiKey(id: number, userId: number, revokedAt = new Date()): Promise<boolean> {
    const apiKey = this.apiKeys.get(id);
    if (!apiKey || apiKey.userId !== userId || apiKey.revokedAt !== null) {
      return false;
    }

    this.apiKeys.set(id, {
      ...apiKey,
      revokedAt,
    });

    return true;
  }

  async createWebhook(data: InsertWebhook): Promise<Webhook> {
    const id = this.nextWebhookId++;
    const webhook: Webhook = {
      id,
      userId: data.userId,
      url: data.url,
      events: [...data.events],
      secret: data.secret,
      createdAt: new Date(),
    };

    this.webhooks.set(id, webhook);
    return webhook;
  }

  async getWebhook(id: number): Promise<Webhook | undefined> {
    return this.webhooks.get(id);
  }

  async listWebhooksForEvent(userId: number, event: WebhookEventType): Promise<Webhook[]> {
    return Array.from(this.webhooks.values())
      .filter((webhook) => webhook.userId === userId && webhook.events.includes(event))
      .sort((left, right) => {
        const createdDelta = (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0);
        if (createdDelta !== 0) {
          return createdDelta;
        }

        return left.id - right.id;
      });
  }

  async deleteWebhook(id: number, userId: number): Promise<boolean> {
    const webhook = this.webhooks.get(id);
    if (!webhook || webhook.userId !== userId) {
      return false;
    }

    this.webhooks.delete(id);
    return true;
  }

  async createIdempotencyKey(data: InsertIdempotencyKey): Promise<IdempotencyKey> {
    const id = this.nextIdempotencyKeyId++;
    const key: IdempotencyKey = {
      id,
      keyHash: data.keyHash,
      requestHash: data.requestHash,
      responseStatus: data.responseStatus,
      responseBody: data.responseBody,
      userId: data.userId ?? null,
      visitorId: data.visitorId ?? null,
      conversionId: data.conversionId ?? null,
      createdAt: new Date(),
      expiresAt: data.expiresAt,
    };

    this.idempotencyKeys.set(id, key);
    return key;
  }

  async getIdempotencyKey(
    keyHash: string,
    scope: IdempotencyScope,
    now = new Date(),
  ): Promise<IdempotencyKey | undefined> {
    for (const [id, record] of Array.from(this.idempotencyKeys.entries())) {
      if (record.expiresAt.getTime() <= now.getTime()) {
        this.idempotencyKeys.delete(id);
        continue;
      }

      if (record.keyHash === keyHash && matchesIdempotencyScope(record, scope)) {
        return record;
      }
    }

    return undefined;
  }

  async deleteExpiredIdempotencyKeys(now: Date): Promise<number> {
    let deleted = 0;

    for (const [id, record] of Array.from(this.idempotencyKeys.entries())) {
      if (record.expiresAt.getTime() > now.getTime()) {
        continue;
      }

      this.idempotencyKeys.delete(id);
      deleted += 1;
    }

    return deleted;
  }

  async createUsageEvent(data: InsertUsageEvent): Promise<UsageEvent> {
    const id = this.nextUsageEventId++;
    const event: UsageEvent = {
      id,
      userId: data.userId,
      eventType: data.eventType,
      format: data.format,
      fileSize: data.fileSize,
      createdAt: new Date(),
    };

    this.usageEvents.set(id, event);
    return event;
  }

  async countUsageEventsSince(
    userId: number,
    eventType: UsageEventType,
    since: Date,
  ): Promise<number> {
    return Array.from(this.usageEvents.values()).filter((event) => (
      event.userId === userId &&
      event.eventType === eventType &&
      (event.createdAt?.getTime() ?? 0) >= since.getTime()
    )).length;
  }

  async countVisitorConversionsSince(visitorId: string, since: Date): Promise<number> {
    return Array.from(this.conversions.values()).filter((conversion) => (
      conversion.userId === null &&
      conversion.visitorId === visitorId &&
      conversion.status === "completed" &&
      (conversion.createdAt?.getTime() ?? 0) >= since.getTime()
    )).length;
  }

  async listPresets(userId: number): Promise<Preset[]> {
    return Array.from(this.presets.values())
      .filter((preset) => preset.userId === userId)
      .sort(sortByCreatedDesc);
  }

  async deletePreset(id: number, userId: number): Promise<boolean> {
    const preset = this.presets.get(id);
    if (!preset || preset.userId !== userId) {
      return false;
    }

    this.presets.delete(id);

    for (const [conversionId, conversion] of Array.from(this.conversions.entries())) {
      if (conversion.presetId !== id) {
        continue;
      }

      this.conversions.set(conversionId, {
        ...conversion,
        presetId: null,
      });
    }

    return true;
  }
}

export const storage = hasDatabaseUrl() ? new DrizzleStorage() : new MemStorage();
