import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { registry } from "../../server/converters/registry";
import { validateOutputFile } from "../../server/converters/validation";
import {
  assertOutputFile,
  createCsvFixture,
  createXlsxFixture,
  withTempDir,
} from "./helpers";

const cases = [
  { source: "csv", target: "xlsx", createInput: createCsvFixture },
  { source: "csv", target: "json", createInput: createCsvFixture },
  { source: "xlsx", target: "csv", createInput: createXlsxFixture },
  { source: "xlsx", target: "json", createInput: createXlsxFixture },
] as const;

for (const conversionCase of cases) {
  test(`data adapter converts ${conversionCase.source} to ${conversionCase.target}`, async () => {
    await withTempDir(async (dir) => {
      const inputPath = path.join(dir, `input.${conversionCase.source}`);
      const outputPath = path.join(dir, `output.${conversionCase.target}`);

      await conversionCase.createInput(inputPath);
      await registry.getAdapter(conversionCase.source, conversionCase.target).convert(inputPath, outputPath);

      const output = assertOutputFile(outputPath, conversionCase.target);
      assert.equal(output.matchesExtension, true);
      assert.ok(output.size > 0);
      await validateOutputFile(outputPath, conversionCase.target);
    });
  });
}
