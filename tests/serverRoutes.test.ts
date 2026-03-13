import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { registerRoutes } from "../server/routes";
import { VISITOR_ID_HEADER } from "../shared/visitor";

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
      status: "processing" | "completed" | "failed";
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
