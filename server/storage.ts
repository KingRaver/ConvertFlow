import type {
  Conversion,
  ConversionStatus,
  InsertConversion,
  InsertSession,
  InsertUser,
  InsertUsageEvent,
  Session,
  User,
  UsageEvent,
  UsageEventType,
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

export interface IStorage {
  createConversion(conversion: InsertConversion): Promise<Conversion>;
  getConversion(id: number): Promise<Conversion | undefined>;
  getConversionByOutputFilename(outputFilename: string): Promise<Conversion | undefined>;
  updateConversion(id: number, updates: Partial<Conversion>): Promise<Conversion | undefined>;
  listConversions(options: ConversionListOptions): Promise<PaginatedConversions>;
  getExpiredConversions(now: Date): Promise<Conversion[]>;
  failStaleProcessingJobs(cutoff: Date, resultMessage: string): Promise<number>;
  deleteConversion(id: number): Promise<void>;
  createUser(user: InsertUser): Promise<User>;
  createUserWithSession(user: InsertUser, session: InsertSession): Promise<{ session: Session; user: User }>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserById(id: number): Promise<User | undefined>;
  updateUser(id: number, updates: Partial<User>): Promise<User | undefined>;
  createSession(session: InsertSession): Promise<Session>;
  getSessionByToken(token: string): Promise<Session | undefined>;
  deleteSessionByToken(token: string): Promise<void>;
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

export class MemStorage implements IStorage {
  private conversions: Map<number, Conversion>;
  private nextConversionId: number;
  private nextSessionId: number;
  private nextUserId: number;
  private nextUsageEventId: number;
  private sessions: Map<number, Session>;
  private usageEvents: Map<number, UsageEvent>;
  private users: Map<number, User>;

  constructor() {
    this.conversions = new Map();
    this.users = new Map();
    this.sessions = new Map();
    this.usageEvents = new Map();
    this.nextConversionId = 1;
    this.nextUserId = 1;
    this.nextSessionId = 1;
    this.nextUsageEventId = 1;
  }

  async createConversion(data: InsertConversion): Promise<Conversion> {
    const id = this.nextConversionId++;
    const conversion: Conversion = {
      id,
      originalName: data.originalName,
      originalFormat: data.originalFormat,
      targetFormat: data.targetFormat,
      status: data.status ?? "pending",
      fileSize: data.fileSize,
      convertedSize: data.convertedSize ?? null,
      outputFilename: data.outputFilename ?? null,
      resultMessage: data.resultMessage ?? null,
      visitorId: data.visitorId ?? null,
      userId: data.userId ?? null,
      processingStartedAt: data.processingStartedAt ?? null,
      engineUsed: data.engineUsed ?? null,
      createdAt: new Date(),
      expiresAt: data.expiresAt ?? null,
    };
    this.conversions.set(id, conversion);
    return conversion;
  }

  async getConversion(id: number): Promise<Conversion | undefined> {
    return this.conversions.get(id);
  }

  async getConversionByOutputFilename(outputFilename: string): Promise<Conversion | undefined> {
    return Array.from(this.conversions.values()).find(
      (conversion) => conversion.outputFilename === outputFilename,
    );
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
}

export const storage = hasDatabaseUrl() ? new DrizzleStorage() : new MemStorage();
