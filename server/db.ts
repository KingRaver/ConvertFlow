import process from "node:process";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@shared/schema";

try { (process as NodeJS.Process & { loadEnvFile?: () => void }).loadEnvFile?.(); } catch { /* no .env file in production */ }

export const databaseUrl = process.env.DATABASE_URL?.trim() || undefined;

export const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
    })
  : null;

export const db = pool
  ? drizzle(pool, {
      schema,
    })
  : null;

export function hasDatabaseUrl() {
  return Boolean(databaseUrl);
}

export function getDb() {
  if (!db) {
    throw new Error("DATABASE_URL is required to use DrizzleStorage.");
  }

  return db;
}
