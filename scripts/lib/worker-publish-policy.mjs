const fullCommitPattern = /^[a-f0-9]{40}$/;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export function validateWorkerPublishSource(input) {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) =>
        !["eventName", "expectedSha", "actualSha", "refType", "refName", "version"].includes(key),
    )
  ) {
    throw new Error("publish source contains unsupported fields");
  }
  if (!fullCommitPattern.test(input.actualSha ?? "")) {
    throw new Error("GITHUB_SHA must be a full lowercase commit SHA");
  }
  if (!versionPattern.test(input.version ?? "")) {
    throw new Error("worker runtime version must be a strict semantic version");
  }

  if (input.eventName === "workflow_dispatch") {
    if (!fullCommitPattern.test(input.expectedSha ?? "")) {
      throw new Error("source_sha must be a full lowercase 40-character commit SHA");
    }
    if (input.expectedSha !== input.actualSha) {
      throw new Error(
        `selected ref resolved to ${input.actualSha}, not requested ${input.expectedSha}`,
      );
    }
    return {
      event: "manual",
      sourceSha: input.actualSha,
      version: input.version,
    };
  }

  if (input.eventName === "push") {
    if (input.refType !== "tag") {
      throw new Error("automatic worker publication is allowed only for tags");
    }
    const expectedTag = `worker-runtime-v${input.version}`;
    if (input.refName !== expectedTag) {
      throw new Error(
        `tag ${String(input.refName)} does not match worker runtime version ${input.version}`,
      );
    }
    return {
      event: "tag",
      sourceSha: input.actualSha,
      version: input.version,
      tag: input.refName,
    };
  }

  throw new Error(`unsupported publication event: ${String(input.eventName)}`);
}
