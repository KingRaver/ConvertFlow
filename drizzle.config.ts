import process from "node:process";
import { defineConfig } from "drizzle-kit";

(process as NodeJS.Process & { loadEnvFile?: () => void }).loadEnvFile?.();

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
