import test from "node:test";
import assert from "node:assert/strict";
import { SUPPORTED_CONVERSIONS } from "../../shared/schema";
import { registry } from "../../server/converters/registry";

// Verify every route in SUPPORTED_CONVERSIONS has a registered adapter.
// If a new route is added to the schema without a corresponding adapter,
// this test will catch it before it reaches production.
test("registry has an adapter for every supported conversion route", () => {
  const missing: string[] = [];

  for (const [sourceFormat, targets] of Object.entries(SUPPORTED_CONVERSIONS)) {
    for (const targetFormat of targets) {
      try {
        registry.getAdapter(sourceFormat, targetFormat);
      } catch {
        missing.push(`${sourceFormat}->${targetFormat}`);
      }
    }
  }

  assert.deepEqual(
    missing,
    [],
    `Missing adapters for routes: ${missing.join(", ")}`,
  );
});
