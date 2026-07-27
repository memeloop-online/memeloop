import assert from "node:assert/strict";
import test from "node:test";

import { validateWorkerPublishSource } from "../lib/worker-publish-policy.mjs";

const sha = "a".repeat(40);
const base = {
  eventName: "workflow_dispatch",
  expectedSha: sha,
  actualSha: sha,
  refType: "branch",
  refName: "feat/orchestration",
  version: "0.0.1",
};

test("manual publication is bound to the exact selected commit", () => {
  assert.deepEqual(validateWorkerPublishSource(base), {
    event: "manual",
    sourceSha: sha,
    version: "0.0.1",
  });
  assert.throws(
    () =>
      validateWorkerPublishSource({
        ...base,
        expectedSha: "b".repeat(40),
      }),
    /selected ref resolved/,
  );
  assert.throws(
    () => validateWorkerPublishSource({ ...base, expectedSha: "main" }),
    /full lowercase/,
  );
});

test("automatic publication requires the exact version tag", () => {
  assert.deepEqual(
    validateWorkerPublishSource({
      ...base,
      eventName: "push",
      expectedSha: "",
      refType: "tag",
      refName: "worker-runtime-v0.0.1",
    }),
    {
      event: "tag",
      sourceSha: sha,
      version: "0.0.1",
      tag: "worker-runtime-v0.0.1",
    },
  );
  assert.throws(
    () =>
      validateWorkerPublishSource({
        ...base,
        eventName: "push",
        refType: "branch",
      }),
    /only for tags/,
  );
  assert.throws(
    () =>
      validateWorkerPublishSource({
        ...base,
        eventName: "push",
        refType: "tag",
        refName: "worker-runtime-v0.0.2",
      }),
    /does not match/,
  );
});

test("publication rejects unknown events, malformed versions, and extensions", () => {
  assert.throws(
    () => validateWorkerPublishSource({ ...base, eventName: "pull_request" }),
    /unsupported publication event/,
  );
  assert.throws(
    () => validateWorkerPublishSource({ ...base, version: "latest" }),
    /semantic version/,
  );
  assert.throws(
    () => validateWorkerPublishSource({ ...base, unexpected: true }),
    /unsupported fields/,
  );
});
