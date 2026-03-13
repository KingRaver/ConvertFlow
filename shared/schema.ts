import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const USER_ROLES = ["user", "admin"] as const;
export type UserRole = typeof USER_ROLES[number];
export const USER_PLANS = ["free", "pro", "business"] as const;
export type UserPlan = typeof USER_PLANS[number];
export const USAGE_EVENT_TYPES = ["conversion"] as const;
export type UsageEventType = typeof USAGE_EVENT_TYPES[number];

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
  plan: text("plan").notNull().default("free"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const usageEvents = pgTable("usage_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  format: text("format").notNull(),
  fileSize: integer("file_size").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const conversions = pgTable("conversions", {
  id: serial("id").primaryKey(),
  originalName: text("original_name").notNull(),
  originalFormat: text("original_format").notNull(),
  targetFormat: text("target_format").notNull(),
  status: text("status").notNull().default("pending"), // pending | processing | completed | failed
  fileSize: integer("file_size").notNull(),
  convertedSize: integer("converted_size"),
  outputFilename: text("output_filename"),
  resultMessage: text("result_message"),
  visitorId: text("visitor_id"),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  processingStartedAt: timestamp("processing_started_at"),
  engineUsed: text("engine_used"),
  createdAt: timestamp("created_at").defaultNow(),
  expiresAt: timestamp("expires_at"),
});

export const insertConversionSchema = createInsertSchema(conversions).omit({
  id: true,
  createdAt: true,
});
export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
});
export const insertSessionSchema = createInsertSchema(sessions).omit({
  id: true,
  createdAt: true,
});
export const insertUsageEventSchema = createInsertSchema(usageEvents).omit({
  id: true,
  createdAt: true,
});

export type InsertConversion = z.infer<typeof insertConversionSchema>;
export type InsertSession = z.infer<typeof insertSessionSchema>;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type InsertUsageEvent = z.infer<typeof insertUsageEventSchema>;
export type Conversion = typeof conversions.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type User = typeof users.$inferSelect;
export type UsageEvent = typeof usageEvents.$inferSelect;

export const CONVERSION_STATUSES = ["pending", "processing", "completed", "failed"] as const;
export type ConversionStatus = typeof CONVERSION_STATUSES[number];

// Supported format conversions
export const SUPPORTED_CONVERSIONS: Record<string, string[]> = {
  "pdf": ["docx", "jpg", "png", "txt", "csv"],
  "docx": ["pdf", "txt"],
  "doc": ["pdf", "txt"],
  "png": ["jpg", "webp", "pdf"],
  "jpg": ["png", "webp", "pdf"],
  "jpeg": ["png", "webp", "pdf"],
  "webp": ["png", "jpg"],
  "gif": ["mp4", "png", "jpg"],
  "mp4": ["gif", "mp3", "wav"],
  "mp3": ["wav", "ogg"],
  "wav": ["mp3", "ogg"],
  "csv": ["xlsx", "json"],
  "xlsx": ["csv", "json"],
  "txt": ["pdf", "docx"],
  "svg": ["png", "jpg"],
  "bmp": ["png", "jpg"],
  "tiff": ["png", "jpg"],
};

export const SUPPORTED_FORMATS = Array.from(
  new Set(
    Object.entries(SUPPORTED_CONVERSIONS).flatMap(([sourceFormat, targetFormats]) => [
      sourceFormat,
      ...targetFormats,
    ]),
  ),
).sort();

export const FORMAT_CATEGORIES: Record<string, { label: string; formats: string[]; icon: string }> = {
  "documents": { label: "Documents", formats: ["pdf", "docx", "doc", "txt"], icon: "FileText" },
  "images": { label: "Images", formats: ["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "tiff"], icon: "Image" },
  "audio": { label: "Audio", formats: ["mp3", "wav", "ogg"], icon: "Music" },
  "video": { label: "Video", formats: ["mp4", "gif"], icon: "Video" },
  "data": { label: "Data", formats: ["csv", "xlsx", "json"], icon: "Table" },
};

export const POPULAR_CONVERSIONS = [
  { from: "pdf", to: "docx", label: "PDF to Word", slug: "pdf-to-word" },
  { from: "pdf", to: "jpg", label: "PDF to JPG", slug: "pdf-to-jpg" },
  { from: "png", to: "jpg", label: "PNG to JPG", slug: "png-to-jpg" },
  { from: "docx", to: "pdf", label: "Word to PDF", slug: "docx-to-pdf" },
  { from: "mp4", to: "gif", label: "MP4 to GIF", slug: "mp4-to-gif" },
  { from: "mp3", to: "wav", label: "MP3 to WAV", slug: "mp3-to-wav" },
  { from: "csv", to: "xlsx", label: "CSV to Excel", slug: "csv-to-xlsx" },
  { from: "jpg", to: "png", label: "JPG to PNG", slug: "jpg-to-png" },
  { from: "webp", to: "png", label: "WEBP to PNG", slug: "webp-to-png" },
  { from: "jpg", to: "webp", label: "JPG to WEBP", slug: "jpg-to-webp" },
  { from: "png", to: "webp", label: "PNG to WEBP", slug: "png-to-webp" },
  { from: "wav", to: "mp3", label: "WAV to MP3", slug: "wav-to-mp3" },
];
