import test from "node:test";
import assert from "node:assert/strict";
import { getOrCreateVisitorId } from "../client/src/lib/visitor";
import { VISITOR_ID_STORAGE_KEY, isValidVisitorId } from "../shared/visitor";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

test("getOrCreateVisitorId persists and reuses a valid visitor id", () => {
  const storage = new MemoryStorage();
  const first = getOrCreateVisitorId(storage, () => "11111111-1111-4111-8111-111111111111");
  const second = getOrCreateVisitorId(storage, () => "22222222-2222-4222-8222-222222222222");

  assert.equal(first, second);
  assert.equal(storage.getItem(VISITOR_ID_STORAGE_KEY), first);
  assert.equal(isValidVisitorId(first), true);
});

test("getOrCreateVisitorId replaces an invalid stored value", () => {
  const storage = new MemoryStorage();
  storage.setItem(VISITOR_ID_STORAGE_KEY, "anonymous");

  const visitorId = getOrCreateVisitorId(
    storage,
    () => "33333333-3333-4333-8333-333333333333",
  );

  assert.equal(visitorId, "cf_33333333-3333-4333-8333-333333333333");
  assert.equal(isValidVisitorId(visitorId), true);
});
