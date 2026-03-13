import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { createServer } from "node:http";
import { expireConversionRecord } from "../server/conversion-jobs";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";
import { VISITOR_ID_HEADER } from "../shared/visitor";

const VISITOR_ID = "cf_77777777-7777-4777-8777-777777777777";
const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6X6uoAAAAASUVORK5CYII=",
  "base64",
);

let emailCounter = 0;

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

async function registerUser(baseUrl: string) {
  emailCounter += 1;
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: `phase8-${emailCounter}@example.com`,
      password: "password123",
    }),
  });

  assert.equal(response.status, 201);
  return response.json() as Promise<{
    token: string;
    user: { id: number };
  }>;
}

function createAuthHeader(token: string) {
  return {
    authorization: `Bearer ${token}`,
  };
}

async function cleanupConversion(id: number) {
  const conversion = await storage.getConversion(id);
  if (!conversion) {
    return;
  }

  await expireConversionRecord(conversion);
}

async function waitForSettledJob(baseUrl: string, headers: HeadersInit, conversionId: number) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/convert/${conversionId}`, {
      headers,
    });

    assert.equal(response.status, 200);
    const json = await response.json() as {
      convertedSize?: number | null;
      outputFilename?: string | null;
      resultMessage?: string | null;
      status: "pending" | "processing" | "completed" | "failed";
    };

    if (json.status === "completed" || json.status === "failed") {
      return json;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Timed out waiting for conversion to settle.");
}

async function waitForBatchToSettle(baseUrl: string, headers: HeadersInit, batchId: number) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/batch/${batchId}`, {
      headers,
    });

    assert.equal(response.status, 200);
    const json = await response.json() as {
      completedJobs: number;
      failedJobs: number;
      jobs?: Array<{ id: number; status: string }>;
      status: string;
      totalJobs: number;
    };

    if (json.completedJobs + json.failedJobs === json.totalJobs) {
      return json;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Timed out waiting for batch to settle.");
}

function buildComplexSvg() {
  const shapes: string[] = [];

  for (let row = 0; row < 12; row += 1) {
    for (let column = 0; column < 16; column += 1) {
      const x = 40 + column * 45;
      const y = 40 + row * 40;
      const hue = (row * 30 + column * 17) % 360;
      shapes.push(`<rect x="${x}" y="${y}" width="36" height="30" rx="6" fill="hsl(${hue} 75% 55%)" />`);
      shapes.push(`<circle cx="${x + 18}" cy="${y + 15}" r="10" fill="rgba(255,255,255,0.35)" />`);
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f172a" />
      <stop offset="100%" stop-color="#155e75" />
    </linearGradient>
  </defs>
  <rect width="960" height="640" fill="url(#bg)" />
  <text x="60" y="90" font-size="52" fill="#f8fafc" font-family="Helvetica">Phase 8 Quality Test</text>
  ${shapes.join("\n")}
</svg>`;
}

test("presets can be created, listed, applied to conversions, and deleted", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const account = await registerUser(server.baseUrl);
  const headers = createAuthHeader(account.token);

  const createPresetResponse = await fetch(`${server.baseUrl}/api/presets`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "Text to DOCX",
      sourceFormat: "txt",
      targetFormat: "docx",
      options: {},
    }),
  });
  assert.equal(createPresetResponse.status, 201);
  const createPresetJson = await createPresetResponse.json() as {
    preset: { id: number; sourceFormat: string; targetFormat: string };
  };
  assert.equal(createPresetJson.preset.sourceFormat, "txt");
  assert.equal(createPresetJson.preset.targetFormat, "docx");

  const listPresetResponse = await fetch(`${server.baseUrl}/api/presets`, {
    headers,
  });
  assert.equal(listPresetResponse.status, 200);
  const listedPresets = await listPresetResponse.json() as {
    items: Array<{ id: number }>;
  };
  assert.equal(listedPresets.items.some((item) => item.id === createPresetJson.preset.id), true);

  const formData = new FormData();
  formData.append(
    "file",
    new File([Buffer.from("preset flow\n")], "sample.txt", { type: "text/plain" }),
  );
  formData.append("presetId", String(createPresetJson.preset.id));

  const convertResponse = await fetch(`${server.baseUrl}/api/convert`, {
    method: "POST",
    headers,
    body: formData,
  });
  assert.equal(convertResponse.status, 201);
  const created = await convertResponse.json() as {
    id: number;
    presetId: number | null;
    status: string;
    targetFormat: string;
  };
  assert.equal(created.targetFormat, "docx");
  assert.equal(created.presetId, createPresetJson.preset.id);
  t.after(async () => {
    await cleanupConversion(created.id);
  });

  const settled = await waitForSettledJob(server.baseUrl, headers, created.id);
  assert.equal(settled.status, "completed");

  const deletePresetResponse = await fetch(`${server.baseUrl}/api/presets/${createPresetJson.preset.id}`, {
    method: "DELETE",
    headers,
  });
  assert.equal(deletePresetResponse.status, 204);

  const listAfterDeleteResponse = await fetch(`${server.baseUrl}/api/presets`, {
    headers,
  });
  const afterDelete = await listAfterDeleteResponse.json() as {
    items: Array<{ id: number }>;
  };
  assert.equal(afterDelete.items.some((item) => item.id === createPresetJson.preset.id), false);
});

function parseZipEntryNames(archive: Buffer): string[] {
  const eocdOffset = archive.length - 22;
  if (archive.readUInt32LE(eocdOffset) !== 0x06054B50) {
    throw new Error("Invalid ZIP: end of central directory signature not found");
  }

  const entryCount = archive.readUInt16LE(eocdOffset + 8);
  const cdOffset = archive.readUInt32LE(eocdOffset + 16);

  const names: string[] = [];
  let cursor = cdOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014B50) {
      throw new Error("Invalid ZIP: central directory entry signature not found");
    }

    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    names.push(archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"));
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return names;
}

test("batch upload reports progress and returns a zip of completed outputs", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const account = await registerUser(server.baseUrl);
  const headers = createAuthHeader(account.token);

  const formData = new FormData();
  formData.append(
    "files",
    new File([Buffer.from("batch one\n")], "one.txt", { type: "text/plain" }),
  );
  formData.append(
    "files",
    new File([Buffer.from("batch two\n")], "two.txt", { type: "text/plain" }),
  );
  formData.append("targetFormat", "docx");

  const createBatchResponse = await fetch(`${server.baseUrl}/api/batch`, {
    method: "POST",
    headers,
    body: formData,
  });
  assert.equal(createBatchResponse.status, 201);
  const createdBatch = await createBatchResponse.json() as {
    id: number;
    jobs?: Array<{ id: number }>;
    status: string;
    totalJobs: number;
  };
  assert.equal(createdBatch.totalJobs, 2);
  assert.equal(createdBatch.jobs?.length, 2);

  t.after(async () => {
    for (const job of createdBatch.jobs ?? []) {
      await cleanupConversion(job.id);
    }
  });

  const settledBatch = await waitForBatchToSettle(server.baseUrl, headers, createdBatch.id);
  assert.equal(settledBatch.completedJobs, 2);
  assert.equal(settledBatch.failedJobs, 0);

  const downloadResponse = await fetch(`${server.baseUrl}/api/batch/${createdBatch.id}/download`, {
    headers,
  });
  assert.equal(downloadResponse.status, 200);
  const archive = Buffer.from(await downloadResponse.arrayBuffer());

  // Validate ZIP magic bytes
  assert.equal(archive.subarray(0, 4).toString("binary"), "PK\u0003\u0004");

  // Validate ZIP contents: should contain one entry per completed job
  const entryNames = parseZipEntryNames(archive);
  assert.equal(entryNames.length, 2);
  assert.ok(entryNames.every((name) => name.endsWith(".docx")), `Expected all entries to be .docx, got: ${entryNames.join(", ")}`);
  assert.ok(new Set(entryNames).size === entryNames.length, "ZIP entry names should be unique");
});

test("batch upload rejects more than the maximum allowed file count", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const account = await registerUser(server.baseUrl);
  const headers = createAuthHeader(account.token);

  const formData = new FormData();
  for (let i = 0; i < 21; i += 1) {
    formData.append(
      "files",
      new File([Buffer.from(`file ${i}\n`)], `file${i}.txt`, { type: "text/plain" }),
    );
  }
  formData.append("targetFormat", "docx");

  const response = await fetch(`${server.baseUrl}/api/batch`, {
    method: "POST",
    headers,
    body: formData,
  });
  assert.equal(response.status, 400);
  const json = await response.json() as { error: string };
  assert.ok(
    json.error.toLowerCase().includes("20"),
    `Expected error to mention the limit of 20, got: ${json.error}`,
  );
});

test("batch idempotency key prevents duplicate batch creation on retry", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const account = await registerUser(server.baseUrl);
  const headers = createAuthHeader(account.token);
  const idempotencyKey = `batch-idem-${Date.now()}`;

  const buildFormData = () => {
    const fd = new FormData();
    fd.append("files", new File([Buffer.from("idempotent content\n")], "doc.txt", { type: "text/plain" }));
    fd.append("targetFormat", "docx");
    return fd;
  };

  const first = await fetch(`${server.baseUrl}/api/batch`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": idempotencyKey },
    body: buildFormData(),
  });
  assert.equal(first.status, 201);
  const firstBatch = await first.json() as { id: number; jobs?: Array<{ id: number }> };

  t.after(async () => {
    for (const job of firstBatch.jobs ?? []) {
      await cleanupConversion(job.id);
    }
  });

  // Wait for batch to settle so idempotency key is stored
  await waitForBatchToSettle(server.baseUrl, headers, firstBatch.id);

  const second = await fetch(`${server.baseUrl}/api/batch`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": idempotencyKey },
    body: buildFormData(),
  });
  assert.equal(second.status, 201);
  const secondBatch = await second.json() as { id: number };

  // Same idempotency key must return the same batch id
  assert.equal(secondBatch.id, firstBatch.id);
});

test("retry re-enqueues a failed conversion using the retained input file", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const formData = new FormData();
  formData.append(
    "file",
    new File([Buffer.from("not really a png")], "broken.png", { type: "image/png" }),
  );
  formData.append("targetFormat", "jpg");

  const createResponse = await fetch(`${server.baseUrl}/api/convert`, {
    method: "POST",
    headers: {
      [VISITOR_ID_HEADER]: VISITOR_ID,
    },
    body: formData,
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as { id: number };
  t.after(async () => {
    await cleanupConversion(created.id);
  });

  const failed = await waitForSettledJob(server.baseUrl, {
    [VISITOR_ID_HEADER]: VISITOR_ID,
  }, created.id);
  assert.equal(failed.status, "failed");

  const storedConversion = await storage.getConversion(created.id);
  assert.ok(storedConversion?.inputKey, "inputKey should be retained for retries");
  fs.writeFileSync(path.join(process.cwd(), storedConversion.inputKey), VALID_PNG);

  const retryResponse = await fetch(`${server.baseUrl}/api/convert/${created.id}/retry`, {
    method: "POST",
    headers: {
      [VISITOR_ID_HEADER]: VISITOR_ID,
    },
  });
  assert.equal(retryResponse.status, 200);
  const retried = await retryResponse.json() as { status: string };
  assert.equal(retried.status, "pending");

  const completed = await waitForSettledJob(server.baseUrl, {
    [VISITOR_ID_HEADER]: VISITOR_ID,
  }, created.id);
  assert.equal(completed.status, "completed");
});

test("conversion options are validated and affect supported routes", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const invalidForm = new FormData();
  invalidForm.append(
    "file",
    new File([Buffer.from("invalid options\n")], "sample.txt", { type: "text/plain" }),
  );
  invalidForm.append("targetFormat", "docx");
  invalidForm.append("options", JSON.stringify({ quality: 50 }));

  const invalidResponse = await fetch(`${server.baseUrl}/api/convert`, {
    method: "POST",
    headers: {
      [VISITOR_ID_HEADER]: VISITOR_ID,
    },
    body: invalidForm,
  });
  assert.equal(invalidResponse.status, 400);

  const svg = buildComplexSvg();
  const lowQualityForm = new FormData();
  lowQualityForm.append(
    "file",
    new File([Buffer.from(svg)], "quality.svg", { type: "image/svg+xml" }),
  );
  lowQualityForm.append("targetFormat", "jpg");
  lowQualityForm.append("options", JSON.stringify({ quality: 20 }));

  const highQualityForm = new FormData();
  highQualityForm.append(
    "file",
    new File([Buffer.from(svg)], "quality.svg", { type: "image/svg+xml" }),
  );
  highQualityForm.append("targetFormat", "jpg");
  highQualityForm.append("options", JSON.stringify({ quality: 95 }));

  const lowResponse = await fetch(`${server.baseUrl}/api/convert`, {
    method: "POST",
    headers: {
      [VISITOR_ID_HEADER]: VISITOR_ID,
    },
    body: lowQualityForm,
  });
  assert.equal(lowResponse.status, 201);
  const lowCreated = await lowResponse.json() as { id: number };

  const highResponse = await fetch(`${server.baseUrl}/api/convert`, {
    method: "POST",
    headers: {
      [VISITOR_ID_HEADER]: VISITOR_ID,
    },
    body: highQualityForm,
  });
  assert.equal(highResponse.status, 201);
  const highCreated = await highResponse.json() as { id: number };

  t.after(async () => {
    await cleanupConversion(lowCreated.id);
    await cleanupConversion(highCreated.id);
  });

  const lowSettled = await waitForSettledJob(server.baseUrl, {
    [VISITOR_ID_HEADER]: VISITOR_ID,
  }, lowCreated.id);
  const highSettled = await waitForSettledJob(server.baseUrl, {
    [VISITOR_ID_HEADER]: VISITOR_ID,
  }, highCreated.id);

  assert.equal(lowSettled.status, "completed");
  assert.equal(highSettled.status, "completed");
  assert.ok((highSettled.convertedSize ?? 0) > (lowSettled.convertedSize ?? 0));
});

test("quality option boundary values are rejected outside 1-100 range", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const svg = buildComplexSvg();

  for (const quality of [0, 101, -1, 1000]) {
    const form = new FormData();
    form.append(
      "file",
      new File([Buffer.from(svg)], "test.svg", { type: "image/svg+xml" }),
    );
    form.append("targetFormat", "jpg");
    form.append("options", JSON.stringify({ quality }));

    const response = await fetch(`${server.baseUrl}/api/convert`, {
      method: "POST",
      headers: { [VISITOR_ID_HEADER]: VISITOR_ID },
      body: form,
    });
    assert.equal(
      response.status,
      400,
      `Expected quality=${quality} to be rejected with 400`,
    );
  }
});

test("batch with one invalid file produces partial status and zip with only successful outputs", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const account = await registerUser(server.baseUrl);
  const headers = createAuthHeader(account.token);

  const formData = new FormData();
  formData.append(
    "files",
    new File([VALID_PNG], "good.png", { type: "image/png" }),
  );
  formData.append(
    "files",
    new File([Buffer.from("this is not a valid png")], "bad.png", { type: "image/png" }),
  );
  formData.append("targetFormat", "jpg");

  const createBatchResponse = await fetch(`${server.baseUrl}/api/batch`, {
    method: "POST",
    headers,
    body: formData,
  });
  assert.equal(createBatchResponse.status, 201);
  const createdBatch = await createBatchResponse.json() as {
    id: number;
    jobs?: Array<{ id: number }>;
    totalJobs: number;
  };
  assert.equal(createdBatch.totalJobs, 2);

  t.after(async () => {
    for (const job of createdBatch.jobs ?? []) {
      await cleanupConversion(job.id);
    }
  });

  const settledBatch = await waitForBatchToSettle(server.baseUrl, headers, createdBatch.id);
  assert.equal(settledBatch.status, "partial");
  assert.equal(settledBatch.completedJobs, 1);
  assert.equal(settledBatch.failedJobs, 1);

  const downloadResponse = await fetch(`${server.baseUrl}/api/batch/${createdBatch.id}/download`, {
    headers,
  });
  assert.equal(downloadResponse.status, 200);
  const archive = Buffer.from(await downloadResponse.arrayBuffer());
  const entryNames = parseZipEntryNames(archive);
  assert.equal(entryNames.length, 1);
  assert.ok(entryNames[0]!.endsWith(".jpg"), `Expected a .jpg entry, got: ${entryNames[0]}`);
});

test("creating a preset with an unsupported format combination returns 400", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const account = await registerUser(server.baseUrl);
  const headers = createAuthHeader(account.token);

  const response = await fetch(`${server.baseUrl}/api/presets`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "Invalid Combo",
      sourceFormat: "txt",
      targetFormat: "mp4",
      options: {},
    }),
  });
  assert.equal(response.status, 400);
  const json = await response.json() as { error: string };
  assert.ok(json.error.length > 0, "Expected a non-empty error message");
});

test("a preset belonging to one user is not accessible to another user", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const ownerAccount = await registerUser(server.baseUrl);
  const otherAccount = await registerUser(server.baseUrl);

  const createPresetResponse = await fetch(`${server.baseUrl}/api/presets`, {
    method: "POST",
    headers: {
      ...createAuthHeader(ownerAccount.token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "Owner Only Preset",
      sourceFormat: "txt",
      targetFormat: "docx",
      options: {},
    }),
  });
  assert.equal(createPresetResponse.status, 201);
  const { preset } = await createPresetResponse.json() as { preset: { id: number } };

  const formData = new FormData();
  formData.append(
    "file",
    new File([Buffer.from("some content\n")], "sample.txt", { type: "text/plain" }),
  );
  formData.append("presetId", String(preset.id));

  const convertResponse = await fetch(`${server.baseUrl}/api/convert`, {
    method: "POST",
    headers: createAuthHeader(otherAccount.token),
    body: formData,
  });
  assert.equal(convertResponse.status, 404);
  const json = await convertResponse.json() as { error: string };
  assert.ok(json.error.toLowerCase().includes("preset"), `Expected preset-related error, got: ${json.error}`);
});

test("retrying a conversion whose input file was deleted returns 409", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const formData = new FormData();
  formData.append(
    "file",
    new File([Buffer.from("not really a png")], "broken.png", { type: "image/png" }),
  );
  formData.append("targetFormat", "jpg");

  const createResponse = await fetch(`${server.baseUrl}/api/convert`, {
    method: "POST",
    headers: {
      [VISITOR_ID_HEADER]: VISITOR_ID,
    },
    body: formData,
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as { id: number };
  t.after(async () => {
    await cleanupConversion(created.id);
  });

  const failed = await waitForSettledJob(server.baseUrl, { [VISITOR_ID_HEADER]: VISITOR_ID }, created.id);
  assert.equal(failed.status, "failed");

  const storedConversion = await storage.getConversion(created.id);
  assert.ok(storedConversion?.inputKey, "inputKey should be retained after failure");

  // Delete the input file to simulate it being cleaned up
  try {
    fs.unlinkSync(path.join(process.cwd(), storedConversion.inputKey));
  } catch {
    // Already gone — that's fine
  }

  const retryResponse = await fetch(`${server.baseUrl}/api/convert/${created.id}/retry`, {
    method: "POST",
    headers: { [VISITOR_ID_HEADER]: VISITOR_ID },
  });
  assert.equal(retryResponse.status, 409);
  const json = await retryResponse.json() as { error: string };
  assert.ok(
    json.error.toLowerCase().includes("no longer available"),
    `Expected "no longer available" in error, got: ${json.error}`,
  );
});

test("retrying a non-failed conversion returns 409", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const account = await registerUser(server.baseUrl);
  const headers = createAuthHeader(account.token);

  const formData = new FormData();
  formData.append(
    "file",
    new File([Buffer.from("retry guard\n")], "sample.txt", { type: "text/plain" }),
  );
  formData.append("targetFormat", "docx");

  const createResponse = await fetch(`${server.baseUrl}/api/convert`, {
    method: "POST",
    headers,
    body: formData,
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as { id: number };
  t.after(async () => {
    await cleanupConversion(created.id);
  });

  // Retry while still pending — should be rejected
  const retryPendingResponse = await fetch(`${server.baseUrl}/api/convert/${created.id}/retry`, {
    method: "POST",
    headers,
  });
  assert.equal(retryPendingResponse.status, 409);

  // Wait to complete, then retry — should also be rejected
  const settled = await waitForSettledJob(server.baseUrl, headers, created.id);
  assert.equal(settled.status, "completed");

  const retryCompletedResponse = await fetch(`${server.baseUrl}/api/convert/${created.id}/retry`, {
    method: "POST",
    headers,
  });
  assert.equal(retryCompletedResponse.status, 409);
});
