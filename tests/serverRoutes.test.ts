import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { createServer } from "node:http";
import { registerRoutes } from "../server/routes";
import { OUTPUT_DIR } from "../server/files";
import { VISITOR_ID_HEADER } from "../shared/visitor";
import { storage } from "../server/storage";

const VISITOR_A = "cf_55555555-5555-4555-8555-555555555555";
const VISITOR_B = "cf_66666666-6666-4666-8666-666666666666";
let emailCounter = 0;

function removeOutputFile(outputFilename?: string | null) {
  if (!outputFilename) {
    return;
  }

  const outputPath = path.join(OUTPUT_DIR, outputFilename);
  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath);
  }
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

async function registerUser(baseUrl: string) {
  emailCounter += 1;
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: `tester-${emailCounter}@example.com`,
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

async function waitForSettledJob(
  baseUrl: string,
  headers: HeadersInit,
  conversionId: number,
) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/convert/${conversionId}`, {
      headers,
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
  t.after(async () => {
    await storage.deleteConversion(created.id);
  });

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
  const ownHistoryJson = (await ownHistory.json()) as {
    items: Array<{ id: number }>;
    total: number;
  };
  assert.equal(ownHistory.status, 200);
  assert.equal(ownHistoryJson.items.length, 1);
  assert.equal(ownHistoryJson.items[0]?.id, created.id);
  assert.equal(ownHistoryJson.total, 1);

  const foreignHistory = await fetch(`${server.baseUrl}/api/conversions`, {
    headers: {
      [VISITOR_ID_HEADER]: VISITOR_B,
    },
  });
  const foreignHistoryJson = (await foreignHistory.json()) as {
    items: Array<{ id: number }>;
    total: number;
  };
  assert.equal(foreignHistory.status, 200);
  assert.equal(foreignHistoryJson.items.length, 0);
  assert.equal(foreignHistoryJson.total, 0);
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

  const settled = await waitForSettledJob(server.baseUrl, {
    [VISITOR_ID_HEADER]: VISITOR_A,
  }, created.id);
  removeOutputFile(settled.outputFilename);
  await storage.deleteConversion(created.id);
});

test("free accounts are blocked after reaching the daily conversion limit", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const account = await registerUser(server.baseUrl);

  for (let index = 0; index < 10; index += 1) {
    await storage.createUsageEvent({
      eventType: "conversion",
      fileSize: 1024,
      format: "txt->docx",
      userId: account.user.id,
    });
  }

  const formData = new FormData();
  formData.append(
    "file",
    new File([Buffer.from("limit test\n")], "sample.txt", { type: "text/plain" }),
  );
  formData.append("targetFormat", "docx");

  const response = await fetch(`${server.baseUrl}/api/convert`, {
    method: "POST",
    headers: createAuthHeader(account.token),
    body: formData,
  });

  const json = await response.json() as { error: string };
  assert.equal(response.status, 429);
  assert.match(json.error, /10 conversions per UTC day/);
});

test("free accounts enforce the 10MB upload cap", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const account = await registerUser(server.baseUrl);
  const formData = new FormData();
  formData.append(
    "file",
    new File([Buffer.alloc(11 * 1024 * 1024, 1)], "oversized.txt", { type: "text/plain" }),
  );
  formData.append("targetFormat", "docx");

  const response = await fetch(`${server.baseUrl}/api/convert`, {
    method: "POST",
    headers: createAuthHeader(account.token),
    body: formData,
  });

  const json = await response.json() as { error: string };
  assert.equal(response.status, 413);
  assert.match(json.error, /10MB/);
});

test("pro accounts receive longer retention and usage metering on successful conversions", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const account = await registerUser(server.baseUrl);
  await storage.updateUser(account.user.id, {
    plan: "pro",
  });

  const beforeUpload = Date.now();
  const formData = new FormData();
  formData.append(
    "file",
    new File([Buffer.from("pro retention test\n")], "sample.txt", { type: "text/plain" }),
  );
  formData.append("targetFormat", "docx");

  const response = await fetch(`${server.baseUrl}/api/convert`, {
    method: "POST",
    headers: createAuthHeader(account.token),
    body: formData,
  });

  assert.equal(response.status, 201);
  const created = await response.json() as {
    expiresAt: string;
    id: number;
  };

  const expiresAt = new Date(created.expiresAt).getTime();
  const retentionMs = expiresAt - beforeUpload;
  assert.ok(retentionMs >= 6.5 * 24 * 60 * 60 * 1000, "pro retention should be about 7 days");

  const settled = await waitForSettledJob(server.baseUrl, createAuthHeader(account.token), created.id);
  assert.equal(settled.status, "completed");
  removeOutputFile(settled.outputFilename);
  await storage.deleteConversion(created.id);

  const usageCount = await storage.countUsageEventsSince(
    account.user.id,
    "conversion",
    new Date(beforeUpload - 1_000),
  );
  assert.equal(usageCount, 1);
});

test("completed jobs expose a real visitor-scoped download", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const created = await createTextToDocxJob(server.baseUrl, VISITOR_A);
  const status = await waitForSettledJob(server.baseUrl, {
    [VISITOR_ID_HEADER]: VISITOR_A,
  }, created.id);

  assert.equal(status.status, "completed");
  assert.equal(status.engineUsed, "docx");
  assert.ok(status.outputFilename);

  const ownDownloadRedirect = await fetch(`${server.baseUrl}/api/download/${status.outputFilename}`, {
    headers: {
      [VISITOR_ID_HEADER]: VISITOR_A,
    },
    redirect: "manual",
  });
  assert.equal(ownDownloadRedirect.status, 302);
  const location = ownDownloadRedirect.headers.get("location");
  assert.ok(location);
  assert.match(location, /^\/api\/download\/local\?/);

  const ownDownload = await fetch(new URL(location, server.baseUrl));
  assert.equal(ownDownload.status, 200);

  const downloadedBytes = Buffer.from(await ownDownload.arrayBuffer());
  assert.ok(downloadedBytes.length > 0);

  const foreignDownload = await fetch(`${server.baseUrl}/api/download/${status.outputFilename}`, {
    headers: {
      [VISITOR_ID_HEADER]: VISITOR_B,
    },
  });
  assert.equal(foreignDownload.status, 404);

  removeOutputFile(status.outputFilename);
  await storage.deleteConversion(created.id);
});

test("failed jobs expose their error status but no downloadable output", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  // createDemoJob sends "%PDF-demo" — not a real PDF, so pdf→docx will fail
  const created = await createDemoJob(server.baseUrl, VISITOR_A);
  const status = await waitForSettledJob(server.baseUrl, {
    [VISITOR_ID_HEADER]: VISITOR_A,
  }, created.id);

  assert.equal(status.status, "failed");
  assert.equal(status.outputFilename, null);

  const download = await fetch(`${server.baseUrl}/api/download/nonexistent.docx`, {
    headers: { [VISITOR_ID_HEADER]: VISITOR_A },
  });
  assert.equal(download.status, 404);
  await storage.deleteConversion(created.id);
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
    userId: null,
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

test("auth endpoints create, resolve, and revoke account sessions", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const registration = await registerUser(server.baseUrl);
  const login = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: `tester-${emailCounter}@example.com`,
      password: "password123",
    }),
  });
  assert.equal(login.status, 200);
  const loginJson = (await login.json()) as { token: string };
  assert.ok(loginJson.token);

  const me = await fetch(`${server.baseUrl}/api/auth/me`, {
    headers: createAuthHeader(loginJson.token),
  });
  assert.equal(me.status, 200);
  const meJson = (await me.json()) as {
    email: string;
    id: number;
    role: string;
  };
  assert.equal(meJson.id, registration.user.id);
  assert.equal(meJson.role, "user");

  const logout = await fetch(`${server.baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: createAuthHeader(loginJson.token),
  });
  assert.equal(logout.status, 204);

  const meAfterLogout = await fetch(`${server.baseUrl}/api/auth/me`, {
    headers: createAuthHeader(loginJson.token),
  });
  assert.equal(meAfterLogout.status, 401);
});

test("register rejects duplicate email with 409", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  await registerUser(server.baseUrl);
  const duplicateEmail = `tester-${emailCounter}@example.com`;

  const second = await fetch(`${server.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: duplicateEmail, password: "password123" }),
  });
  assert.equal(second.status, 409);
  const body = await second.json() as { error: string };
  assert.ok(body.error);
});

test("register rejects missing or invalid fields with 400", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const missingPassword = await fetch(`${server.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "no-password@example.com" }),
  });
  assert.equal(missingPassword.status, 400);

  const missingEmail = await fetch(`${server.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "password123" }),
  });
  assert.equal(missingEmail.status, 400);

  const shortPassword = await fetch(`${server.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "short@example.com", password: "abc" }),
  });
  assert.equal(shortPassword.status, 400);

  const invalidEmail = await fetch(`${server.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "not-an-email", password: "password123" }),
  });
  assert.equal(invalidEmail.status, 400);
});

test("login rejects wrong password with 401", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  await registerUser(server.baseUrl);
  const registeredEmail = `tester-${emailCounter}@example.com`;

  const wrongPassword = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: registeredEmail, password: "wrongpassword" }),
  });
  assert.equal(wrongPassword.status, 401);
  const body = await wrongPassword.json() as { error: string };
  assert.ok(body.error);
});

test("login rejects unknown email with 401", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const response = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "ghost@example.com", password: "password123" }),
  });
  assert.equal(response.status, 401);
});

test("authenticated routes reject missing or invalid tokens with 401", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const noToken = await fetch(`${server.baseUrl}/api/auth/me`);
  assert.equal(noToken.status, 401);

  const badToken = await fetch(`${server.baseUrl}/api/auth/me`, {
    headers: createAuthHeader("not-a-real-token"),
  });
  assert.equal(badToken.status, 401);

  const malformedHeader = await fetch(`${server.baseUrl}/api/auth/me`, {
    headers: { authorization: "NotBearer sometoken" },
  });
  assert.equal(malformedHeader.status, 401);
});

test("authenticated users can create account-owned jobs and query paginated filtered history", async (t) => {
  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const registration = await registerUser(server.baseUrl);

  const firstForm = new FormData();
  firstForm.append(
    "file",
    new File([Buffer.from("alpha\n")], "alpha.txt", { type: "text/plain" }),
  );
  firstForm.append("targetFormat", "docx");

  const firstResponse = await fetch(`${server.baseUrl}/api/convert`, {
    method: "POST",
    headers: createAuthHeader(registration.token),
    body: firstForm,
  });
  assert.equal(firstResponse.status, 201);
  const firstCreated = (await firstResponse.json()) as { id: number };

  const secondForm = new FormData();
  secondForm.append(
    "file",
    new File([Buffer.from("beta\n")], "beta.txt", { type: "text/plain" }),
  );
  secondForm.append("targetFormat", "docx");

  const secondResponse = await fetch(`${server.baseUrl}/api/convert`, {
    method: "POST",
    headers: createAuthHeader(registration.token),
    body: secondForm,
  });
  assert.equal(secondResponse.status, 201);
  const secondCreated = (await secondResponse.json()) as { id: number };

  t.after(async () => {
    const firstSettled = await storage.getConversion(firstCreated.id);
    const secondSettled = await storage.getConversion(secondCreated.id);
    removeOutputFile(firstSettled?.outputFilename);
    removeOutputFile(secondSettled?.outputFilename);
    await storage.deleteConversion(firstCreated.id);
    await storage.deleteConversion(secondCreated.id);
  });

  const firstSettled = await waitForSettledJob(
    server.baseUrl,
    createAuthHeader(registration.token),
    firstCreated.id,
  );
  const secondSettled = await waitForSettledJob(
    server.baseUrl,
    createAuthHeader(registration.token),
    secondCreated.id,
  );

  assert.equal(firstSettled.status, "completed");
  assert.equal(secondSettled.status, "completed");

  const filteredHistory = await fetch(
    `${server.baseUrl}/api/conversions?page=1&limit=1&status=completed&format=docx`,
    {
      headers: createAuthHeader(registration.token),
    },
  );
  assert.equal(filteredHistory.status, 200);
  const filteredHistoryJson = (await filteredHistory.json()) as {
    items: Array<{ id: number; targetFormat: string }>;
    limit: number;
    page: number;
    total: number;
    totalPages: number;
  };
  assert.equal(filteredHistoryJson.items.length, 1);
  assert.equal(filteredHistoryJson.limit, 1);
  assert.equal(filteredHistoryJson.page, 1);
  assert.equal(filteredHistoryJson.total, 2);
  assert.equal(filteredHistoryJson.totalPages, 2);
  assert.equal(filteredHistoryJson.items[0]?.targetFormat, "docx");

  const anonymousAccess = await fetch(`${server.baseUrl}/api/convert/${firstCreated.id}`, {
    headers: {
      [VISITOR_ID_HEADER]: VISITOR_A,
    },
  });
  assert.equal(anonymousAccess.status, 404);
});
