import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { registry } from "../../server/converters/registry";
import { validateOutputFile } from "../../server/converters/validation";
import {
  assertOutputFile,
  createDocFixture,
  createDocxFixture,
  createPdfFixture,
  createTextFixture,
  hasTextutil,
  withTempDir,
} from "./helpers";

const baseCases = [
  { source: "txt", target: "pdf", createInput: createTextFixture },
  { source: "txt", target: "docx", createInput: createTextFixture },
  { source: "docx", target: "txt", createInput: createDocxFixture },
  { source: "docx", target: "pdf", createInput: createDocxFixture },
  { source: "pdf", target: "txt", createInput: createPdfFixture },
  { source: "pdf", target: "png", createInput: createPdfFixture },
  { source: "pdf", target: "jpg", createInput: createPdfFixture },
  { source: "pdf", target: "docx", createInput: createPdfFixture },
] as const;

for (const conversionCase of baseCases) {
  test(`document adapter converts ${conversionCase.source} to ${conversionCase.target}`, async () => {
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

const docTest = hasTextutil() ? test : test.skip;

docTest("document adapter converts doc to txt", async () => {
  await withTempDir(async (dir) => {
    const inputPath = path.join(dir, "input.doc");
    const outputPath = path.join(dir, "output.txt");

    await createDocFixture(inputPath);
    await registry.getAdapter("doc", "txt").convert(inputPath, outputPath);

    const output = assertOutputFile(outputPath, "txt");
    assert.equal(output.matchesExtension, true);
    assert.ok(output.size > 0);
    await validateOutputFile(outputPath, "txt");
  });
});

docTest("document adapter converts doc to pdf", async () => {
  await withTempDir(async (dir) => {
    const inputPath = path.join(dir, "input.doc");
    const outputPath = path.join(dir, "output.pdf");

    await createDocFixture(inputPath);
    await registry.getAdapter("doc", "pdf").convert(inputPath, outputPath);

    const output = assertOutputFile(outputPath, "pdf");
    assert.equal(output.matchesExtension, true);
    assert.ok(output.size > 0);
    await validateOutputFile(outputPath, "pdf");
  });
});
