import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { validateRuntimeConfig } from "../server/runtime-config";
import { registerRoutes } from "../server/routes";

function buildEnv(overrides: Record<string, string | undefined>) {
  return {
    ...process.env,
    ALLOW_MEMORY_STORAGE: "false",
    DATABASE_URL: "",
    LOCAL_FILESTORE_SIGNING_SECRET: "test-local-signing-secret",
    STORAGE_DRIVER: "local",
    ...overrides,
  };
}

function restoreEnv(snapshot: NodeJS.ProcessEnv) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}

test("validateRuntimeConfig requires durable storage unless ALLOW_MEMORY_STORAGE=true is set", () => {
  assert.throws(
    () => validateRuntimeConfig("api", buildEnv({})),
    /ALLOW_MEMORY_STORAGE=true/,
  );
});

test("validateRuntimeConfig requires an explicit signing secret for the local filestore", () => {
  assert.throws(
    () => validateRuntimeConfig("api", buildEnv({ ALLOW_MEMORY_STORAGE: "true", LOCAL_FILESTORE_SIGNING_SECRET: "" })),
    /LOCAL_FILESTORE_SIGNING_SECRET/,
  );
});

test("validateRuntimeConfig rejects standalone workers without PostgreSQL", () => {
  assert.throws(
    () => validateRuntimeConfig("worker", buildEnv({ ALLOW_MEMORY_STORAGE: "true" })),
    /standalone queue worker/,
  );
});

test("registerRoutes fails startup when persistence is missing and memory storage was not explicitly allowed", async () => {
  const snapshot = { ...process.env };
  const app = express();
  const server = createServer(app);

  process.env.DATABASE_URL = "";
  process.env.ALLOW_MEMORY_STORAGE = "false";
  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_FILESTORE_SIGNING_SECRET = "test-local-signing-secret";

  try {
    await assert.rejects(
      () => registerRoutes(server, app),
      /ALLOW_MEMORY_STORAGE=true/,
    );
  } finally {
    restoreEnv(snapshot);
  }
});
