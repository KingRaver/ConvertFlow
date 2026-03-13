import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { registerRoutes } from "../server/routes";
import { VISITOR_ID_HEADER } from "../shared/visitor";
import { storage } from "../server/storage";

const VISITOR_A = "cf_55555555-5555-4555-8555-555555555555";
const VISITOR_B = "cf_66666666-6666-4666-8666-666666666666";

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

async function createDemoJob(baseUrl: string, visitorId: string) {
  const formData = new FormData();
  formData.append(
    "file",
    new File([Buffer.from("%PDF-demo")], "sample.pdf", { type: "application/pdf" }),
  );
  formData.append("targetFormat", "docx");

  const response = await fetch(`${baseUrl}/api/convert`, {
    method: "POST",
    headers: {
      [VISITOR_ID_HEADER]: visitorId,
    },
    body: formData,
  });

  assert.equal(response.status, 201);
  return response.json() as Promise<{ id: number }>;
}

async function createTextToDocxJob(baseUrl: string, visitorId: string) {
  const formData = new FormData();
  formData.append(
    "file",
    new File([Buffer.from("ConvertFlow route test\n")], "sample.txt", { type: "text/plain" }),
  );
  formData.append("targetFormat", "docx");

  const response = await fetch(`${baseUrl}/api/convert`, {
    method: "POST",
    headers: {
      [VISITOR_ID_HEADER]: visitorId,
    },
    body: formData,
  });

  assert.equal(response.status, 201);
  return response.json() as Promise<{ id: number }>;
}

async function waitForSettledJob(baseUrl: string, visitorId: string, conversionId: number) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/convert/${conversionId}`, {
      headers: {
        [VISITOR_ID_HEADER]: visitorId,
      },
    });

    assert.equal(response.status, 200);
    const json = (await response.json()) as {
      engineUsed?: string | null;
      outputFilename?: string | null;
      status: "pending" | "processing" | "completed" | "failed";
    };

    if (json.status === "completed" || json.status === "failed") {
      return json;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Timed out waiting for conversion to settle.");
}

test("route handlers scope job status and history to the current visitor", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const created = await createDemoJob(server.baseUrl, VISITOR_A);

  const ownStatus = await fetch(`${server.baseUrl}/api/convert/${created.id}`, {
    headers: {
      [VISITOR_ID_HEADER]: VISITOR_A,
    },
  });
  assert.equal(ownStatus.status, 200);

  const foreignStatus = await fetch(`${server.baseUrl}/api/convert/${created.id}`, {
    headers: {
      [VISITOR_ID_HEADER]: VISITOR_B,
    },
  });
  assert.equal(foreignStatus.status, 404);

  const ownHistory = await fetch(`${server.baseUrl}/api/conversions`, {
    headers: {
      [VISITOR_ID_HEADER]: VISITOR_A,
    },
  });
  const ownHistoryJson = (await ownHistory.json()) as Array<{ id: number }>;
  assert.equal(ownHistory.status, 200);
  assert.equal(ownHistoryJson.length, 1);
  assert.equal(ownHistoryJson[0]?.id, created.id);

  const foreignHistory = await fetch(`${server.baseUrl}/api/conversions`, {
    headers: {
      [VISITOR_ID_HEADER]: VISITOR_B,
    },
  });
  const foreignHistoryJson = (await foreignHistory.json()) as Array<{ id: number }>;
  assert.equal(foreignHistory.status, 200);
  assert.equal(foreignHistoryJson.length, 0);
});

test("queued uploads return pending immediately before the worker settles them", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const formData = new FormData();
  formData.append(
    "file",
    new File([Buffer.from("ConvertFlow route test\n")], "sample.txt", { type: "text/plain" }),
  );
  formData.append("targetFormat", "docx");

  const response = await fetch(`${server.baseUrl}/api/convert`, {
    method: "POST",
    headers: {
      [VISITOR_ID_HEADER]: VISITOR_A,
    },
    body: formData,
  });

  assert.equal(response.status, 201);

  const created = (await response.json()) as {
    id: number;
    processingStartedAt: string | null;
    resultMessage: string | null;
    status: "pending" | "processing" | "completed" | "failed";
  };

  assert.equal(created.status, "pending");
  assert.equal(created.processingStartedAt, null);
  assert.equal(created.resultMessage, "Queued .txt to .docx conversion.");
});

test("completed jobs expose a real visitor-scoped download", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const created = await createTextToDocxJob(server.baseUrl, VISITOR_A);
  const status = await waitForSettledJob(server.baseUrl, VISITOR_A, created.id);

  assert.equal(status.status, "completed");
  assert.equal(status.engineUsed, "docx");
  assert.ok(status.outputFilename);

  const ownDownload = await fetch(`${server.baseUrl}/api/download/${status.outputFilename}`, {
    headers: {
      [VISITOR_ID_HEADER]: VISITOR_A,
    },
  });
  assert.equal(ownDownload.status, 200);

  const downloadedBytes = Buffer.from(await ownDownload.arrayBuffer());
  assert.ok(downloadedBytes.length > 0);

  const foreignDownload = await fetch(`${server.baseUrl}/api/download/${status.outputFilename}`, {
    headers: {
      [VISITOR_ID_HEADER]: VISITOR_B,
    },
  });
  assert.equal(foreignDownload.status, 404);
});

test("failed jobs expose their error status but no downloadable output", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  // createDemoJob sends "%PDF-demo" — not a real PDF, so pdf→docx will fail
  const created = await createDemoJob(server.baseUrl, VISITOR_A);
  const status = await waitForSettledJob(server.baseUrl, VISITOR_A, created.id);

  assert.equal(status.status, "failed");
  assert.equal(status.outputFilename, null);

  const download = await fetch(`${server.baseUrl}/api/download/nonexistent.docx`, {
    headers: { [VISITOR_ID_HEADER]: VISITOR_A },
  });
  assert.equal(download.status, 404);
});

test("GET /api/convert/:id returns 404 and cleans up an expired conversion", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  // Insert an already-expired record directly into the shared MemStorage singleton.
  const expired = await storage.createConversion({
    originalName: "old.txt",
    originalFormat: "txt",
    targetFormat: "docx",
    status: "completed",
    fileSize: 10,
    convertedSize: 10,
    outputFilename: null,
    processingStartedAt: null,
    engineUsed: null,
    resultMessage: "Done",
    visitorId: VISITOR_A,
    expiresAt: new Date(Date.now() - 1_000),
  });

  const response = await fetch(`${server.baseUrl}/api/convert/${expired.id}`, {
    headers: { [VISITOR_ID_HEADER]: VISITOR_A },
  });
  assert.equal(response.status, 404);
  const body = await response.json() as { error: string };
  assert.equal(body.error, "Conversion expired.");

  // The route should have deleted the record.
  assert.equal(
    await storage.getConversion(expired.id),
    undefined,
    "expired record should be deleted from storage",
  );
});
