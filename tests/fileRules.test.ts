import test from "node:test";
import assert from "node:assert/strict";
import { buildAcceptAttribute, validateFilesForRoute } from "../client/src/lib/fileRules";

test("buildAcceptAttribute locks to the preset source format", () => {
  assert.equal(buildAcceptAttribute("pdf"), ".pdf");
});

test("buildAcceptAttribute includes multiple formats on the general uploader", () => {
  const accept = buildAcceptAttribute();

  assert.match(accept, /\.pdf/);
  assert.match(accept, /\.png/);
  assert.match(accept, /\.mp4/);
});

test("validateFilesForRoute rejects unsupported and wrong-route files", () => {
  const result = validateFilesForRoute(
    [{ name: "report.pdf" }, { name: "photo.png" }, { name: "archive.zip" }],
    "pdf",
  );

  assert.deepEqual(
    result.accepted.map((file) => file.name),
    ["report.pdf"],
  );
  assert.equal(result.rejected.length, 2);
  assert.match(result.rejected[0]?.reason ?? "", /only accepts \.pdf files/i);
  assert.match(result.rejected[1]?.reason ?? "", /unsupported file format/i);
});
