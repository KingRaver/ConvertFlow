import { and, asc, desc, eq, isNotNull, lt, lte } from "drizzle-orm";
import type { Conversion, InsertConversion } from "@shared/schema";
import { conversions } from "@shared/schema";
import { getDb } from "../db";
import type { IStorage } from "../storage";

function stripUndefined(updates: Partial<Conversion>) {
  return Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined),
  ) as Partial<Conversion>;
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

  async getConversionsByVisitor(visitorId: string): Promise<Conversion[]> {
    return this.db
      .select()
      .from(conversions)
      .where(eq(conversions.visitorId, visitorId))
      .orderBy(desc(conversions.createdAt), desc(conversions.id));
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
}
