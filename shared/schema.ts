import { integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const USER_ROLES = ["user", "admin"] as const;
export type UserRole = typeof USER_ROLES[number];
export const USER_PLANS = ["free", "pro", "business"] as const;
export type UserPlan = typeof USER_PLANS[number];
export const USAGE_EVENT_TYPES = ["conversion"] as const;
export type UsageEventType = typeof USAGE_EVENT_TYPES[number];
export const WEBHOOK_EVENT_TYPES = ["conversion.completed", "conversion.failed"] as const;
export type WebhookEventType = typeof WEBHOOK_EVENT_TYPES[number];
export const BATCH_STATUSES = ["pending", "processing", "completed", "failed", "partial"] as const;
export type BatchStatus = typeof BATCH_STATUSES[number];

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

export const batches = pgTable("batches", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  totalJobs: integer("total_jobs").notNull(),
  completedJobs: integer("completed_jobs").notNull(),
  failedJobs: integer("failed_jobs").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const presets = pgTable("presets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  sourceFormat: text("source_format").notNull(),
  targetFormat: text("target_format").notNull(),
  options: jsonb("options").$type<Record<string, unknown>>().notNull(),
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

export const apiKeys = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  keyHash: text("key_hash").notNull().unique(),
  name: text("name").notNull(),
  lastUsedAt: timestamp("last_used_at"),
  createdAt: timestamp("created_at").defaultNow(),
  revokedAt: timestamp("revoked_at"),
});

export const webhooks = pgTable("webhooks", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  events: text("events").array().notNull(),
  secret: text("secret").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const idempotencyKeys = pgTable("idempotency_keys", {
  id: serial("id").primaryKey(),
  keyHash: text("key_hash").notNull(),
  requestHash: text("request_hash").notNull(),
  responseStatus: integer("response_status").notNull(),
  responseBody: text("response_body").notNull(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  visitorId: text("visitor_id"),
  conversionId: integer("conversion_id").references(() => conversions.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
});

export const conversions = pgTable("conversions", {
  id: serial("id").primaryKey(),
  originalName: text("original_name").notNull(),
  originalFormat: text("original_format").notNull(),
  targetFormat: text("target_format").notNull(),
  inputKey: text("input_key"),
  status: text("status").notNull().default("pending"), // pending | processing | completed | failed
  fileSize: integer("file_size").notNull(),
  convertedSize: integer("converted_size"),
  outputFilename: text("output_filename"),
  resultMessage: text("result_message"),
  visitorId: text("visitor_id"),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  batchId: integer("batch_id").references(() => batches.id, { onDelete: "set null" }),
  presetId: integer("preset_id").references(() => presets.id, { onDelete: "set null" }),
  options: jsonb("options").$type<Record<string, unknown> | null>(),
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
export const insertBatchSchema = createInsertSchema(batches).omit({
  id: true,
  createdAt: true,
});
export const insertPresetSchema = createInsertSchema(presets).omit({
  id: true,
  createdAt: true,
});
export const insertUsageEventSchema = createInsertSchema(usageEvents).omit({
  id: true,
  createdAt: true,
});
export const insertApiKeySchema = createInsertSchema(apiKeys).omit({
  id: true,
  createdAt: true,
});
export const insertWebhookSchema = createInsertSchema(webhooks).omit({
  id: true,
  createdAt: true,
});
export const insertIdempotencyKeySchema = createInsertSchema(idempotencyKeys).omit({
  id: true,
  createdAt: true,
});

export type InsertConversion = z.infer<typeof insertConversionSchema>;
export type InsertSession = z.infer<typeof insertSessionSchema>;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type InsertBatch = z.infer<typeof insertBatchSchema>;
export type InsertPreset = z.infer<typeof insertPresetSchema>;
export type InsertUsageEvent = z.infer<typeof insertUsageEventSchema>;
export type InsertApiKey = z.infer<typeof insertApiKeySchema>;
export type InsertWebhook = z.infer<typeof insertWebhookSchema>;
export type InsertIdempotencyKey = z.infer<typeof insertIdempotencyKeySchema>;
export type Conversion = typeof conversions.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type User = typeof users.$inferSelect;
export type Batch = typeof batches.$inferSelect;
export type Preset = typeof presets.$inferSelect;
export type UsageEvent = typeof usageEvents.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Webhook = typeof webhooks.$inferSelect;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;

export const CONVERSION_STATUSES = ["pending", "processing", "completed", "failed"] as const;
export type ConversionStatus = typeof CONVERSION_STATUSES[number];

const emptyOptionsSchema = z.object({}).strict();
const imageQualityOptionsSchema = z.object({
  quality: z.coerce.number().int().min(1).max(100).optional(),
}).strict();
const pdfTextOptionsSchema = z.object({
  pageEnd: z.coerce.number().int().min(1).optional(),
  pageStart: z.coerce.number().int().min(1).optional(),
}).strict().refine(
  (value) => value.pageStart === undefined
    || value.pageEnd === undefined
    || value.pageStart <= value.pageEnd,
  {
    message: "pageStart must be less than or equal to pageEnd.",
    path: ["pageStart"],
  },
);
const pdfImageOptionsSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  quality: z.coerce.number().int().min(1).max(100).optional(),
  scale: z.coerce.number().min(1).max(4).optional(),
}).strict();
const audioBitrateOptionsSchema = z.object({
  bitrateKbps: z.coerce.number().int().min(32).max(320).optional(),
}).strict();
const videoGifOptionsSchema = z.object({
  fps: z.coerce.number().int().min(1).max(30).optional(),
  width: z.coerce.number().int().min(64).max(1920).optional(),
}).strict();

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

export const SUPPORTED_CONVERSION_OPTIONS: Record<string, Record<string, z.ZodTypeAny>> = {
  "pdf": {
    "csv": pdfTextOptionsSchema,
    "docx": pdfTextOptionsSchema,
    "jpg": pdfImageOptionsSchema,
    "png": pdfImageOptionsSchema,
    "txt": pdfTextOptionsSchema,
  },
  "png": {
    "jpg": imageQualityOptionsSchema,
    "webp": imageQualityOptionsSchema,
  },
  "jpg": {
    "webp": imageQualityOptionsSchema,
  },
  "jpeg": {
    "webp": imageQualityOptionsSchema,
  },
  "webp": {
    "jpg": imageQualityOptionsSchema,
  },
  "gif": {
    "mp4": emptyOptionsSchema,
    "jpg": imageQualityOptionsSchema,
  },
  "mp4": {
    "gif": videoGifOptionsSchema,
    "mp3": audioBitrateOptionsSchema,
  },
  "mp3": {
    "ogg": audioBitrateOptionsSchema,
  },
  "wav": {
    "mp3": audioBitrateOptionsSchema,
    "ogg": audioBitrateOptionsSchema,
  },
  "svg": {
    "jpg": imageQualityOptionsSchema,
  },
  "bmp": {
    "jpg": imageQualityOptionsSchema,
  },
  "tiff": {
    "jpg": imageQualityOptionsSchema,
  },
};

export function getConversionOptionsSchema(sourceFormat: string, targetFormat: string) {
  return SUPPORTED_CONVERSION_OPTIONS[sourceFormat]?.[targetFormat] ?? emptyOptionsSchema;
}

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
