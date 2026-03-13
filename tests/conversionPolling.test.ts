import test from "node:test";
import assert from "node:assert/strict";
import {
  ConversionConnectionError,
  ConversionTimeoutError,
  pollConversionUntilSettled,
} from "../client/src/lib/conversionPolling";

test("pollConversionUntilSettled resolves when the job completes", async () => {
  const progress: number[] = [];
  let attempts = 0;

  const status = await pollConversionUntilSettled({
    id: 42,
    maxAttempts: 4,
    intervalMs: 0,
    sleep: async () => undefined,
    checkStatus: async () => {
      attempts += 1;
      return attempts < 3
        ? { status: "processing" as const, resultMessage: "Still working" }
        : { status: "completed" as const, resultMessage: "Done" };
    },
    onProgress: (value) => progress.push(value),
  });

  assert.equal(status.status, "completed");
  assert.deepEqual(progress, [53, 56]);
});

test("pollConversionUntilSettled times out after the configured attempts", async () => {
  await assert.rejects(
    () =>
      pollConversionUntilSettled({
        id: 7,
        maxAttempts: 2,
        intervalMs: 0,
        sleep: async () => undefined,
        checkStatus: async () => ({ status: "processing" }),
      }),
    ConversionTimeoutError,
  );
});

test("pollConversionUntilSettled wraps fetch failures as connection errors", async () => {
  await assert.rejects(
    () =>
      pollConversionUntilSettled({
        id: 9,
        maxAttempts: 1,
        intervalMs: 0,
        sleep: async () => undefined,
        checkStatus: async () => {
          throw new Error("network");
        },
      }),
    ConversionConnectionError,
  );
});
