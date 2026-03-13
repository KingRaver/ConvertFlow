import test from "node:test";
import assert from "node:assert/strict";
import { fetchDownloadBlob } from "../client/src/lib/api";
import { VISITOR_ID_STORAGE_KEY } from "../shared/visitor";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

test("fetchDownloadBlob throws the server error for failed downloads", async () => {
  const storage = new MemoryStorage();
  storage.setItem(VISITOR_ID_STORAGE_KEY, "cf_44444444-4444-4444-8444-444444444444");

  Object.assign(globalThis, {
    window: { localStorage: storage },
  });

  await assert.rejects(
    () =>
      fetchDownloadBlob(
        "/api/download/demo.txt",
        async () =>
          new Response(JSON.stringify({ error: "Download failed." }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
      ),
    /Download failed\./,
  );
});
