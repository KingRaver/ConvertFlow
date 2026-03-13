import type { Conversion, InsertConversion } from "@shared/schema";

export interface IStorage {
  createConversion(conversion: InsertConversion): Promise<Conversion>;
  getConversion(id: number): Promise<Conversion | undefined>;
  getConversionByOutputFilename(outputFilename: string): Promise<Conversion | undefined>;
  updateConversion(id: number, updates: Partial<Conversion>): Promise<Conversion | undefined>;
  getConversionsByVisitor(visitorId: string): Promise<Conversion[]>;
  deleteConversion(id: number): Promise<void>;
}

export class MemStorage implements IStorage {
  private conversions: Map<number, Conversion>;
  private nextId: number;

  constructor() {
    this.conversions = new Map();
    this.nextId = 1;
  }

  async createConversion(data: InsertConversion): Promise<Conversion> {
    const id = this.nextId++;
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
      visitorId: data.visitorId,
      processingStartedAt: data.processingStartedAt ?? null,
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

  async getConversionsByVisitor(visitorId: string): Promise<Conversion[]> {
    return Array.from(this.conversions.values())
      .filter((c) => c.visitorId === visitorId)
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  }

  async deleteConversion(id: number): Promise<void> {
    this.conversions.delete(id);
  }
}

export const storage = new MemStorage();
