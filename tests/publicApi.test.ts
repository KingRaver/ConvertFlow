import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import express from "express";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expireConversionRecord } from "../server/conversion-jobs";
import { registerRoutes } from "../server/routes";
import { getStorage } from "../server/storage";

let emailCounter = 0;

async function cleanupConversion(id: number) {
  const conversion = await getStorage().getConversion(id);
  if (!conversion) {
    return;
  }

  await expireConversionRecord(conversion);
}

async function startAppServer() {
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
    throw new Error("Failed to start app server.");
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

async function startWebhookReceiver(failuresBeforeSuccess = 0) {
  const requests: Array<{
    body: string;
    headers: IncomingMessage["headers"];
    method?: string;
    pathname?: string;
  }> = [];
  let remainingFailures = failuresBeforeSuccess;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      requests.push({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: req.headers,
        method: req.method,
        pathname: req.url,
      });

      if (remainingFailures > 0) {
        remainingFailures -= 1;
        res.statusCode = 500;
        res.end("retry");
        return;
      }

      res.statusCode = 204;
      res.end();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start webhook receiver.");
  }

  return {
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
    requests,
    url: `http://127.0.0.1:${address.port}/webhook`,
    waitForRequests: async (count: number, timeoutMs = 6_000) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        if (requests.length >= count) {
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      throw new Error(`Timed out waiting for ${count} webhook requests.`);
    },
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
      email: `public-api-${emailCounter}@example.com`,
      password: "password123",
    }),
  });

  assert.equal(response.status, 201);
  return response.json() as Promise<{
    token: string;
    user: { id: number };
  }>;
}

async function createApiKey(baseUrl: string, token: string, name = "Automation") {
  const response = await fetch(`${baseUrl}/api/keys`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name }),
  });

  assert.equal(response.status, 201);
  return response.json() as Promise<{
    apiKey: { id: number; name: string };
    token: string;
  }>;
}

async function createTextConversion(
  baseUrl: string,
  headers: HeadersInit,
  extraHeaders?: HeadersInit,
) {
  const formData = new FormData();
  formData.append(
    "file",
    new File([Buffer.from("ConvertFlow public API test\n")], "sample.txt", { type: "text/plain" }),
  );
  formData.append("targetFormat", "docx");

  const response = await fetch(`${baseUrl}/api/convert`, {
    method: "POST",
    headers: {
      ...headers,
      ...extraHeaders,
    },
    body: formData,
  });

  return response;
}

async function waitForSettledJob(
  baseUrl: string,
  headers: HeadersInit,
  conversionId: number,
) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/convert/${conversionId}`, {
      headers,
    });

    assert.equal(response.status, 200);
    const json = (await response.json()) as {
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

test("API keys authenticate conversion, history, and download routes", async (t) => {
  const server = await startAppServer();
  t.after(async () => {
    await server.close();
  });

  const account = await registerUser(server.baseUrl);
  const createdKey = await createApiKey(server.baseUrl, account.token, "CLI");
  assert.match(createdKey.token, /^cf_/);

  const listResponse = await fetch(`${server.baseUrl}/api/keys`, {
    headers: {
      authorization: `Bearer ${account.token}`,
    },
  });
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json() as {
    items: Array<{ id: number; lastUsedAt: string | null; name: string }>;
  };
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0]?.id, createdKey.apiKey.id);
  assert.equal(listed.items[0]?.name, "CLI");
  assert.equal(listed.items[0]?.lastUsedAt, null);

  const apiHeaders = {
    authorization: `Bearer ${createdKey.token}`,
  };

  const createResponse = await createTextConversion(server.baseUrl, apiHeaders);
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as { id: number };
  t.after(async () => {
    await cleanupConversion(created.id);
  });

  const jobResponse = await fetch(`${server.baseUrl}/api/convert/${created.id}`, {
    headers: apiHeaders,
  });
  assert.equal(jobResponse.status, 200);

  const settled = await waitForSettledJob(server.baseUrl, apiHeaders, created.id);

  const historyResponse = await fetch(`${server.baseUrl}/api/conversions`, {
    headers: apiHeaders,
  });
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json() as {
    items: Array<{ id: number }>;
  };
  assert.equal(history.items.some((item) => item.id === created.id), true);

  assert.ok(settled.outputFilename, "output file should exist before download");
  const downloadResponse = await fetch(
    `${server.baseUrl}/api/download/${settled.outputFilename}`,
    {
      headers: apiHeaders,
      redirect: "manual",
    },
  );
  assert.equal(downloadResponse.status, 302);
  assert.ok(downloadResponse.headers.get("location"));
  await cleanupConversion(created.id);

  const revokeResponse = await fetch(`${server.baseUrl}/api/keys/${createdKey.apiKey.id}`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${account.token}`,
    },
  });
  assert.equal(revokeResponse.status, 204);

  const revokedResponse = await fetch(`${server.baseUrl}/api/conversions`, {
    headers: apiHeaders,
  });
  assert.equal(revokedResponse.status, 401);
  const revokedJson = await revokedResponse.json() as { error: string };
  assert.match(revokedJson.error, /Invalid authentication token/i);
});

test("Idempotency-Key reuses the original conversion response", async (t) => {
  const server = await startAppServer();
  t.after(async () => {
    await server.close();
  });

  const account = await registerUser(server.baseUrl);
  const createdKey = await createApiKey(server.baseUrl, account.token);
  const headers = {
    authorization: `Bearer ${createdKey.token}`,
  };

  const firstResponse = await createTextConversion(server.baseUrl, headers, {
    "Idempotency-Key": "same-request",
  });
  assert.equal(firstResponse.status, 201);
  const firstJson = await firstResponse.json() as {
    id: number;
    status: string;
  };
  t.after(async () => {
    await cleanupConversion(firstJson.id);
  });

  const secondResponse = await createTextConversion(server.baseUrl, headers, {
    "Idempotency-Key": "same-request",
  });
  assert.equal(secondResponse.status, 201);
  const secondJson = await secondResponse.json() as {
    id: number;
    status: string;
  };

  assert.deepEqual(secondJson, firstJson);

  const historyResponse = await fetch(`${server.baseUrl}/api/conversions`, {
    headers,
  });
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json() as {
    items: Array<{ id: number }>;
    total: number;
  };
  assert.equal(history.total, 1);
  assert.equal(history.items[0]?.id, firstJson.id);

  const settled = await waitForSettledJob(server.baseUrl, headers, firstJson.id);
  await cleanupConversion(firstJson.id);
});

test("conversion webhooks are signed and retried after failures", async (t) => {
  const appServer = await startAppServer();
  const receiver = await startWebhookReceiver(1);
  t.after(async () => {
    await receiver.close();
    await appServer.close();
  });

  const account = await registerUser(appServer.baseUrl);
  const secret = "phase7-test-secret-abcdefghijklmno";
  const webhookResponse = await fetch(`${appServer.baseUrl}/api/webhooks`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${account.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: receiver.url,
      events: ["conversion.completed"],
      secret,
    }),
  });
  assert.equal(webhookResponse.status, 201);
  const webhookJson = await webhookResponse.json() as {
    webhook: { id: number };
    secret: string;
  };
  assert.equal(webhookJson.secret, secret);

  const createResponse = await createTextConversion(appServer.baseUrl, {
    authorization: `Bearer ${account.token}`,
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as { id: number };
  t.after(async () => {
    await cleanupConversion(created.id);
  });

  const settled = await waitForSettledJob(appServer.baseUrl, {
    authorization: `Bearer ${account.token}`,
  }, created.id);

  await receiver.waitForRequests(2);
  assert.equal(receiver.requests.length >= 2, true);

  const delivered = receiver.requests.at(-1);
  assert.ok(delivered);
  assert.equal(delivered.method, "POST");
  assert.equal(delivered.pathname, "/webhook");
  assert.equal(delivered.headers["x-convertflow-event"], "conversion.completed");

  const timestamp = delivered.headers["x-convertflow-timestamp"];
  assert.equal(typeof timestamp, "string");

  const expectedSignature = `sha256=${createHmac("sha256", secret)
    .update(`${timestamp}.${delivered.body}`)
    .digest("hex")}`;
  assert.equal(delivered.headers["x-convertflow-signature"], expectedSignature);

  const payload = JSON.parse(delivered.body) as {
    event: string;
    job: { id: number; status: string };
  };
  assert.equal(payload.event, "conversion.completed");
  assert.equal(payload.job.id, created.id);
  assert.equal(payload.job.status, "completed");

  const deleteResponse = await fetch(`${appServer.baseUrl}/api/webhooks/${webhookJson.webhook.id}`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${account.token}`,
    },
  });
  assert.equal(deleteResponse.status, 204);
});

test("revoking another user's API key returns 404 and leaves the key active", async (t) => {
  const server = await startAppServer();
  t.after(async () => {
    await server.close();
  });

  const account1 = await registerUser(server.baseUrl);
  const account2 = await registerUser(server.baseUrl);
  const key1 = await createApiKey(server.baseUrl, account1.token, "User 1 Key");

  // Account 2 attempts to revoke account 1's key.
  const revokeResponse = await fetch(`${server.baseUrl}/api/keys/${key1.apiKey.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${account2.token}` },
  });
  assert.equal(revokeResponse.status, 404);

  // Key should still be active for account 1.
  const useResponse = await fetch(`${server.baseUrl}/api/conversions`, {
    headers: { authorization: `Bearer ${key1.token}` },
  });
  assert.equal(useResponse.status, 200);
});

test("webhook 4xx response is treated as permanent failure and not retried", async (t) => {
  const appServer = await startAppServer();

  const receivedRequests: string[] = [];
  const rejector = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      receivedRequests.push(Buffer.concat(chunks).toString("utf8"));
      res.statusCode = 400;
      res.end("bad request");
    });
  });
  await new Promise<void>((resolve) => rejector.listen(0, "127.0.0.1", () => resolve()));
  const rejectorAddress = rejector.address();
  if (!rejectorAddress || typeof rejectorAddress === "string") {
    throw new Error("Failed to start rejector server.");
  }
  const rejectorUrl = `http://127.0.0.1:${rejectorAddress.port}/webhook`;

  t.after(async () => {
    await appServer.close();
    await new Promise<void>((resolve, reject) => {
      rejector.close((err) => (err ? reject(err) : resolve()));
    });
  });

  const account = await registerUser(appServer.baseUrl);
  const webhookResponse = await fetch(`${appServer.baseUrl}/api/webhooks`, {
    method: "POST",
    headers: { authorization: `Bearer ${account.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: rejectorUrl, events: ["conversion.completed"] }),
  });
  assert.equal(webhookResponse.status, 201);

  const createResponse = await createTextConversion(appServer.baseUrl, {
    authorization: `Bearer ${account.token}`,
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as { id: number };
  t.after(async () => {
    await cleanupConversion(created.id);
  });

  const settled = await waitForSettledJob(appServer.baseUrl, {
    authorization: `Bearer ${account.token}`,
  }, created.id);

  // Wait for the initial delivery attempt plus the first retry window.
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  // Exactly one attempt: 4xx should not trigger a retry.
  assert.equal(receivedRequests.length, 1);
});

test("API documentation endpoints serve the spec and Redoc shell", async (t) => {
  const server = await startAppServer();
  t.after(async () => {
    await server.close();
  });

  const specResponse = await fetch(`${server.baseUrl}/api/openapi.yaml`);
  assert.equal(specResponse.status, 200);
  const specText = await specResponse.text();
  assert.match(specText, /openapi: 3\.1\.0/);
  assert.match(specText, /\/api\/convert:/);

  const docsResponse = await fetch(`${server.baseUrl}/api/docs`);
  assert.equal(docsResponse.status, 200);
  const docsHtml = await docsResponse.text();
  assert.match(docsHtml, /redoc/i);
  assert.match(docsHtml, /\/api\/openapi\.yaml/);
});
