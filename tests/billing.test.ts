import test from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import { syncStripeBillingEvent } from "../server/billing";
import { MemStorage } from "../server/storage";

function makeSubscriptionEvent(
  type: "customer.subscription.updated" | "customer.subscription.deleted",
  overrides?: Partial<Stripe.Subscription>,
) {
  return {
    type,
    data: {
      object: {
        customer: "cus_test_123",
        id: "sub_test_123",
        metadata: {
          plan: "pro",
          userId: "1",
        },
        ...overrides,
      },
    },
  } as Stripe.Event;
}

test("syncStripeBillingEvent upgrades and downgrades the stored user plan", async () => {
  const storage = new MemStorage();
  const user = await storage.createUser({
    email: "billing@example.com",
    passwordHash: "hashed-password",
    plan: "free",
    role: "user",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
  });

  const upgraded = await syncStripeBillingEvent(
    makeSubscriptionEvent("customer.subscription.updated", {
      metadata: {
        plan: "business",
        userId: String(user.id),
      },
    }),
    storage,
  );

  assert.equal(upgraded, true);
  assert.equal((await storage.getUserById(user.id))?.plan, "business");
  assert.equal((await storage.getUserById(user.id))?.stripeCustomerId, "cus_test_123");
  assert.equal((await storage.getUserById(user.id))?.stripeSubscriptionId, "sub_test_123");

  const downgraded = await syncStripeBillingEvent(
    makeSubscriptionEvent("customer.subscription.deleted", {
      metadata: {
        plan: "business",
        userId: String(user.id),
      },
    }),
    storage,
  );

  assert.equal(downgraded, true);
  assert.equal((await storage.getUserById(user.id))?.plan, "free");
  assert.equal((await storage.getUserById(user.id))?.stripeCustomerId, "cus_test_123");
  assert.equal((await storage.getUserById(user.id))?.stripeSubscriptionId, null);
});

test("syncStripeBillingEvent ignores subscription.updated with unrecognized plan metadata", async () => {
  const storage = new MemStorage();
  const user = await storage.createUser({
    email: "billing2@example.com",
    passwordHash: "hashed-password",
    plan: "pro",
    role: "user",
    stripeCustomerId: "cus_existing",
    stripeSubscriptionId: "sub_existing",
  });

  const result = await syncStripeBillingEvent(
    makeSubscriptionEvent("customer.subscription.updated", {
      metadata: {
        plan: "unknown_tier",
        userId: String(user.id),
      },
    }),
    storage,
  );

  assert.equal(result, false);
  assert.equal((await storage.getUserById(user.id))?.plan, "pro", "plan must not change on bad metadata");
});
