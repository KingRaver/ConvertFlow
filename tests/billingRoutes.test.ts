import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { registerRoutes } from "../server/routes";
import { setBillingProviderForTests } from "../server/billing";

let emailCounter = 0;
type BillingProviderOverride = NonNullable<Parameters<typeof setBillingProviderForTests>[0]>;

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
    throw new Error("Failed to start billing test server.");
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
      email: `billing-route-${emailCounter}@example.com`,
      password: "password123",
    }),
  });

  assert.equal(response.status, 201);
  return response.json() as Promise<{ token: string }>;
}

function createConfiguredBillingProvider(): BillingProviderOverride {
  return {
    async createCheckoutSession({ plan }: { plan: "business" | "pro" }) {
      return {
        customerId: "cus_test_123",
        url: `https://billing.example.test/checkout/${plan}`,
      };
    },
    async createPortalSession() {
      return {
        url: "https://billing.example.test/portal",
      };
    },
    isConfigured() {
      return true;
    },
    constructWebhookEvent(_payload, _signature) {
      throw new Error("Webhook parsing is not exercised in this test.");
    },
  };
}

function createUnconfiguredBillingProvider(): BillingProviderOverride {
  return {
    async createCheckoutSession() {
      throw new Error("Checkout should not be called when billing is disabled.");
    },
    async createPortalSession() {
      throw new Error("Portal should not be called when billing is disabled.");
    },
    isConfigured() {
      return false;
    },
    constructWebhookEvent(_payload, _signature) {
      throw new Error("Webhook parsing is not exercised in this test.");
    },
  };
}

test("billing routes return 503 and health reports billing disabled when Stripe is unconfigured", async (t) => {
  setBillingProviderForTests(createUnconfiguredBillingProvider());
  t.after(() => {
    setBillingProviderForTests(null);
  });

  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const account = await registerUser(server.baseUrl);

  const healthResponse = await fetch(`${server.baseUrl}/api/health`);
  const healthJson = await healthResponse.json() as {
    capabilities: {
      billingConfigured: boolean;
    };
  };

  assert.equal(healthResponse.status, 200);
  assert.equal(healthJson.capabilities.billingConfigured, false);

  const checkoutResponse = await fetch(`${server.baseUrl}/api/billing/checkout`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${account.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ plan: "pro" }),
  });
  const checkoutJson = await checkoutResponse.json() as { error: string };
  assert.equal(checkoutResponse.status, 503);
  assert.equal(checkoutJson.error, "Stripe billing is not configured.");

  const portalResponse = await fetch(`${server.baseUrl}/api/billing/portal`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${account.token}`,
    },
  });
  const portalJson = await portalResponse.json() as { error: string };
  assert.equal(portalResponse.status, 503);
  assert.equal(portalJson.error, "Stripe billing is not configured.");
});

test("billing routes and health expose checkout capability when Stripe is configured", async (t) => {
  setBillingProviderForTests(createConfiguredBillingProvider());
  t.after(() => {
    setBillingProviderForTests(null);
  });

  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const account = await registerUser(server.baseUrl);

  const healthResponse = await fetch(`${server.baseUrl}/api/health`);
  const healthJson = await healthResponse.json() as {
    capabilities: {
      billingConfigured: boolean;
    };
  };

  assert.equal(healthResponse.status, 200);
  assert.equal(healthJson.capabilities.billingConfigured, true);

  const checkoutResponse = await fetch(`${server.baseUrl}/api/billing/checkout`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${account.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ plan: "pro" }),
  });
  const checkoutJson = await checkoutResponse.json() as { url: string };

  assert.equal(checkoutResponse.status, 200);
  assert.equal(checkoutJson.url, "https://billing.example.test/checkout/pro");
});

test("billing checkout uses the first forwarded host and protocol values when proxies append multiple entries", async (t) => {
  let capturedBaseUrl: string | null = null;

  setBillingProviderForTests({
    async createCheckoutSession({ baseUrl, plan }: { baseUrl: string; plan: "business" | "pro" }) {
      capturedBaseUrl = baseUrl;
      return {
        customerId: "cus_test_123",
        url: `https://billing.example.test/checkout/${plan}`,
      };
    },
    async createPortalSession() {
      return {
        url: "https://billing.example.test/portal",
      };
    },
    isConfigured() {
      return true;
    },
    constructWebhookEvent(_payload, _signature) {
      throw new Error("Webhook parsing is not exercised in this test.");
    },
  });
  t.after(() => {
    setBillingProviderForTests(null);
  });

  const server = await startServer();
  t.after(async () => {
    await server.close();
  });

  const account = await registerUser(server.baseUrl);

  const checkoutResponse = await fetch(`${server.baseUrl}/api/billing/checkout`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${account.token}`,
      "Content-Type": "application/json",
      "x-forwarded-host": "convertflow.example.com, internal.proxy.local",
      "x-forwarded-proto": "https, http",
    },
    body: JSON.stringify({ plan: "pro" }),
  });

  assert.equal(checkoutResponse.status, 200);
  assert.equal(capturedBaseUrl, "https://convertflow.example.com");
});
