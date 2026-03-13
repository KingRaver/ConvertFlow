import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { registry } from "../../server/converters/registry";
import { validateOutputFile } from "../../server/converters/validation";
import {
  assertOutputFile,
  createGifFixture,
  createMp3Fixture,
  createMp4Fixture,
  createWavFixture,
  withTempDir,
} from "./helpers";

const cases = [
  { source: "mp3", target: "wav", createInput: createMp3Fixture },
  { source: "mp3", target: "ogg", createInput: createMp3Fixture },
  { source: "wav", target: "mp3", createInput: createWavFixture },
  { source: "wav", target: "ogg", createInput: createWavFixture },
  { source: "mp4", target: "gif", createInput: createMp4Fixture },
  { source: "mp4", target: "mp3", createInput: createMp4Fixture },
  { source: "mp4", target: "wav", createInput: createMp4Fixture },
  { source: "gif", target: "mp4", createInput: createGifFixture },
] as const;

for (const conversionCase of cases) {
  test(`media adapter converts ${conversionCase.source} to ${conversionCase.target}`, async () => {
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
