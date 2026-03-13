import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { registry } from "../../server/converters/registry";
import { validateOutputFile } from "../../server/converters/validation";
import {
  assertOutputFile,
  createBmpFixture,
  createGifFixture,
  createJpgFixture,
  createPngFixture,
  createSvgFixture,
  createTiffFixture,
  createWebpFixture,
  withTempDir,
} from "./helpers";

const cases = [
  { source: "png", target: "jpg", createInput: createPngFixture },
  { source: "png", target: "webp", createInput: createPngFixture },
  { source: "png", target: "pdf", createInput: createPngFixture },
  { source: "jpg", target: "png", createInput: createJpgFixture },
  { source: "jpg", target: "webp", createInput: createJpgFixture },
  { source: "jpg", target: "pdf", createInput: createJpgFixture },
  { source: "webp", target: "png", createInput: createWebpFixture },
  { source: "webp", target: "jpg", createInput: createWebpFixture },
  { source: "svg", target: "png", createInput: createSvgFixture },
  { source: "svg", target: "jpg", createInput: createSvgFixture },
  { source: "bmp", target: "png", createInput: createBmpFixture },
  { source: "bmp", target: "jpg", createInput: createBmpFixture },
  { source: "tiff", target: "png", createInput: createTiffFixture },
  { source: "tiff", target: "jpg", createInput: createTiffFixture },
  { source: "gif", target: "png", createInput: createGifFixture },
  { source: "gif", target: "jpg", createInput: createGifFixture },
] as const;

for (const conversionCase of cases) {
  test(`image adapter converts ${conversionCase.source} to ${conversionCase.target}`, async () => {
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
