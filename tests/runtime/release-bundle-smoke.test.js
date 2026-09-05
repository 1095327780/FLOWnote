const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { inspectReleaseBundle } = require("../../scripts/check-release-bundle.cjs");

test("release bundle loads offline and exposes required embedded Skills resources on desktop and mobile", async () => {
  const result = await inspectReleaseBundle({
    releaseDir: path.join(__dirname, "../../release"),
  });

  assert.ok(result.embeddedFileCount > 100);
  assert.equal(result.embeddedFileCount, result.expectedFileCount);
  assert.deepEqual(result.parity.missing, []);
  assert.deepEqual(result.parity.extra, []);
  assert.deepEqual(result.parity.mismatched, []);
  assert.deepEqual(result.mobileSkillSlugs, result.expectedMobileSkillSlugs);
  assert.deepEqual(result.invalidMobileSkills, []);
  assert.equal(result.ahNoteCompletionPolicy.state, "declared");
  assert.deepEqual(result.ahNoteCompletionPolicy.requiredInteractions, ["ask_user"]);
  assert.equal(result.requiredResourcePaths, undefined);
});
