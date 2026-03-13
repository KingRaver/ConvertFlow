import { and, asc, desc, eq, gte, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type {
  Conversion,
  InsertConversion,
  InsertSession,
  InsertUser,
  InsertUsageEvent,
  Session,
  User,
  UsageEvent,
  UsageEventType,
} from "@shared/schema";
import { conversions, sessions, usageEvents, users } from "@shared/schema";
import { getDb } from "../db";
import type { ConversionListOptions, IStorage, PaginatedConversions } from "../storage";

function stripUndefined<T extends object>(updates: Partial<T>) {
  return Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function buildConversionFilters(options: ConversionListOptions) {
  const conditions = [];

  if (options.userId !== undefined) {
    conditions.push(eq(conversions.userId, options.userId));
  } else if (options.visitorId !== undefined) {
    conditions.push(eq(conversions.visitorId, options.visitorId));
  }

  if (options.status) {
    conditions.push(eq(conversions.status, options.status));
  }

  if (options.format) {
    conditions.push(
      or(
        eq(conversions.originalFormat, options.format),
        eq(conversions.targetFormat, options.format),
      ),
    );
  }

  if (conditions.length === 0) {
    throw new Error("Conversion list queries require either a userId or visitorId.");
  }

  return and(...conditions);
}

export class DrizzleStorage implements IStorage {
  private readonly db = getDb();

  async createConversion(conversion: InsertConversion): Promise<Conversion> {
    const [created] = await this.db.insert(conversions).values(conversion).returning();
    return created;
  }

  async getConversion(id: number): Promise<Conversion | undefined> {
    const [conversion] = await this.db
      .select()
      .from(conversions)
      .where(eq(conversions.id, id));

    return conversion;
  }

  async getConversionByOutputFilename(outputFilename: string): Promise<Conversion | undefined> {
    const [conversion] = await this.db
      .select()
      .from(conversions)
      .where(eq(conversions.outputFilename, outputFilename));

    return conversion;
  }

  async updateConversion(id: number, updates: Partial<Conversion>): Promise<Conversion | undefined> {
    const sanitizedUpdates = stripUndefined(updates);
    if (Object.keys(sanitizedUpdates).length === 0) {
      return this.getConversion(id);
    }

    const [updated] = await this.db
      .update(conversions)
      .set(sanitizedUpdates)
      .where(eq(conversions.id, id))
      .returning();

    return updated;
  }

  async listConversions(options: ConversionListOptions): Promise<PaginatedConversions> {
    const filters = buildConversionFilters(options);
    const offset = (options.page - 1) * options.limit;

    const [totalRow] = await this.db
      .select({ value: sql<number>`count(*)` })
      .from(conversions)
      .where(filters);

    const items = await this.db
      .select()
      .from(conversions)
      .where(filters)
      .orderBy(desc(conversions.createdAt), desc(conversions.id))
      .limit(options.limit)
      .offset(offset);

    return {
      items,
      limit: options.limit,
      page: options.page,
      total: Number(totalRow?.value ?? 0),
    };
  }

  async getExpiredConversions(now: Date): Promise<Conversion[]> {
    return this.db
      .select()
      .from(conversions)
      .where(
        and(
          isNotNull(conversions.expiresAt),
          lte(conversions.expiresAt, now),
        ),
      )
      .orderBy(asc(conversions.expiresAt), asc(conversions.id));
  }

  async failStaleProcessingJobs(cutoff: Date, resultMessage: string): Promise<number> {
    const updated = await this.db
      .update(conversions)
      .set({
        status: "failed",
        resultMessage,
      })
      .where(
        and(
          eq(conversions.status, "processing"),
          isNotNull(conversions.processingStartedAt),
          lt(conversions.processingStartedAt, cutoff),
        ),
      )
      .returning({ id: conversions.id });

    return updated.length;
  }

  async deleteConversion(id: number): Promise<void> {
    await this.db.delete(conversions).where(eq(conversions.id, id));
  }

  async createUserWithSession(userData: InsertUser, sessionData: InsertSession): Promise<{ session: Session; user: User }> {
    return this.db.transaction(async (tx) => {
      const [user] = await tx.insert(users).values(userData).returning();
      const [session] = await tx.insert(sessions).values({ ...sessionData, userId: user.id }).returning();
      return { session, user };
    });
  }

  async createUser(user: InsertUser): Promise<User> {
    const [created] = await this.db.insert(users).values(user).returning();
    return created;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email));

    return user;
  }

  async getUserById(id: number): Promise<User | undefined> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, id));

    return user;
  }

  async updateUser(id: number, updates: Partial<User>): Promise<User | undefined> {
    const sanitizedUpdates = stripUndefined(updates);
    if (Object.keys(sanitizedUpdates).length === 0) {
      return this.getUserById(id);
    }

    const [updated] = await this.db
      .update(users)
      .set(sanitizedUpdates)
      .where(eq(users.id, id))
      .returning();

    return updated;
  }

  async createSession(session: InsertSession): Promise<Session> {
    const [created] = await this.db.insert(sessions).values(session).returning();
    return created;
  }

  async getSessionByToken(token: string): Promise<Session | undefined> {
    const [session] = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.token, token));

    return session;
  }

  async deleteSessionByToken(token: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.token, token));
  }

  async createUsageEvent(event: InsertUsageEvent): Promise<UsageEvent> {
    const [created] = await this.db.insert(usageEvents).values(event).returning();
    return created;
  }

  async countUsageEventsSince(
    userId: number,
    eventType: UsageEventType,
    since: Date,
  ): Promise<number> {
    const [row] = await this.db
      .select({ value: sql<number>`count(*)` })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.userId, userId),
          eq(usageEvents.eventType, eventType),
          gte(usageEvents.createdAt, since),
        ),
      );

    return Number(row?.value ?? 0);
  }

  async countVisitorConversionsSince(visitorId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ value: sql<number>`count(*)` })
      .from(conversions)
      .where(
        and(
          isNull(conversions.userId),
          eq(conversions.visitorId, visitorId),
          eq(conversions.status, "completed"),
          gte(conversions.createdAt, since),
        ),
      );

    return Number(row?.value ?? 0);
  }
}
