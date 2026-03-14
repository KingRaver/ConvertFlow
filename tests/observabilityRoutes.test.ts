import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { expireConversionRecord } from "../server/conversion-jobs";
import { isLegacyDocConverterAvailable } from "../server/converters/runtime";
import { registerRoutes } from "../server/routes";
import { getStorage } from "../server/storage";
import { VISITOR_ID_HEADER } from "../shared/visitor";

const VISITOR_ID = "cf_77777777-7777-4777-8777-777777777777";

async function cleanupConversion(id: number) {
  const conversion = await getStorage().getConversion(id);
  if (!conversion) {
    return;
  }

  await expireConversionRecord(conversion);
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as typeof req & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: false }));

  await registerRoutes(server, app);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start test server.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
  };
}

async function createTextToDocxJob(baseUrl: string) {
  const formData = new FormData();
  formData.append(
    "file",
    new File([Buffer.from("ConvertFlow observability test\n")], "sample.txt", { type: "text/plain" }),
  );
  formData.append("targetFormat", "docx");

  const response = await fetch(`${baseUrl}/api/convert`, {
    method: "POST",
    headers: {
      [VISITOR_ID_HEADER]: VISITOR_ID,
    },
    body: formData,
  });

  assert.equal(response.status, 201);
  return response.json() as Promise<{ id: number }>;
}

async function waitForSettledJob(baseUrl: string, conversionId: number) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/convert/${conversionId}`, {
      headers: {
        [VISITOR_ID_HEADER]: VISITOR_ID,
      },
    });

    assert.equal(response.status, 200);
    const json = (await response.json()) as {
      status: "pending" | "processing" | "completed" | "failed";
    };

    if (json.status === "completed" || json.status === "failed") {
      return json.status;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Timed out waiting for conversion to settle.");
}

test("GET /api/health returns component health for the running service", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const response = await fetch(`${server.baseUrl}/api/health`);
  const json = await response.json() as {
    capabilities: {
      billingConfigured: boolean;
      legacyDocConverterAvailable: boolean;
    };
    db: "ok" | "error";
    queue: "ok" | "error";
    runtime: {
      filestore: "local" | "s3";
      queue: "memory" | "pg-boss";
      storage: "memory" | "postgres";
    };
    status: "ok" | "error";
    storage: "ok" | "error";
  };

  assert.equal(response.status, 200);
  assert.deepEqual(json, {
    capabilities: {
      billingConfigured: false,
      legacyDocConverterAvailable: isLegacyDocConverterAvailable(),
    },
    db: "ok",
    queue: "ok",
    runtime: {
      filestore: "local",
      queue: "memory",
      storage: "memory",
    },
    status: "ok",
    storage: "ok",
  });
});

test("GET /metrics exposes conversion and queue metrics after a job completes", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const created = await createTextToDocxJob(server.baseUrl);
  t.after(async () => {
    await cleanupConversion(created.id);
  });

  assert.equal(await waitForSettledJob(server.baseUrl, created.id), "completed");

  const response = await fetch(`${server.baseUrl}/metrics`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /convertflow_conversion_total/);
  assert.match(body, /route="txt->docx",status="completed"/);
  assert.match(body, /convertflow_queue_depth/);
});

test("GET /metrics requires the monitoring token when configured", async (t) => {
  const previousToken = process.env.MONITORING_TOKEN;
  process.env.MONITORING_TOKEN = "observability-secret";

  const server = await startServer();
  t.after(async () => {
    process.env.MONITORING_TOKEN = previousToken;
    await server.close();
  });

  const unauthorized = await fetch(`${server.baseUrl}/metrics`);
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`${server.baseUrl}/metrics`, {
    headers: {
      "x-monitoring-token": "observability-secret",
    },
  });
  assert.equal(authorized.status, 200);
});
