import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";

const maximumOutputBytes = 256 * 1024;
const canonicalImage = /^ghcr\.io\/linonetwo\/memeloop-worker-runtime@sha256:[a-f0-9]{64}$/;

function readConfiguration() {
  const encoded = process.argv[2];
  if (typeof encoded !== "string" || !/^[a-zA-Z0-9_-]{1,4096}$/.test(encoded)) {
    throw new Error("missing or malformed base64url configuration");
  }
  const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["image", "workers", "concurrency"].includes(key))
  ) {
    throw new Error("configuration contains unsupported fields");
  }
  if (typeof value.image !== "string" || !canonicalImage.test(value.image)) {
    throw new Error("worker image is not the canonical digest-pinned GHCR coordinate");
  }
  for (const field of ["workers", "concurrency"]) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 1 || value[field] > 10_000) {
      throw new Error(`${field} must be an integer between 1 and 10000`);
    }
  }
  return {
    ...value,
    concurrency: Math.min(value.concurrency, value.workers),
  };
}

async function command(commandName, arguments_, { timeoutMs = 120_000 } = {}) {
  const child = spawn(commandName, arguments_, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk) => {
    output += chunk.toString("utf8");
    if (Buffer.byteLength(output, "utf8") > maximumOutputBytes) child.kill("SIGKILL");
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  clearTimeout(timeout);
  if (Buffer.byteLength(output, "utf8") > maximumOutputBytes) {
    throw new Error(`${commandName} exceeded the output bound`);
  }
  if (code !== 0) {
    throw new Error(
      `${commandName} failed with exit code ${String(code)}\n${output.slice(-16_384)}`,
    );
  }
  return output.trim();
}

const configuration = readConfiguration();
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
if (nodeMajor < 24) throw new Error("remote acceptance requires Node 24 or newer");
if (process.platform !== "linux") throw new Error("remote acceptance requires Linux");

const [machineId, bootId, kernel, dockerServer] = await Promise.all([
  readFile("/etc/machine-id", "utf8").then((value) => value.trim()),
  readFile("/proc/sys/kernel/random/boot_id", "utf8").then((value) => value.trim()),
  Promise.resolve(os.release()),
  command("docker", ["version", "--format", "{{.Server.Version}}"]),
]);
assert.ok(machineId.length >= 8, "remote host has no stable machine ID");
assert.ok(bootId.length >= 8, "remote host has no boot ID");

await command("docker", ["pull", configuration.image], { timeoutMs: 10 * 60_000 });
const inspection = JSON.parse(
  await command("docker", ["image", "inspect", configuration.image, "--format", "{{json .}}"]),
);
assert.equal(inspection.Config?.User, "1000:1000", "worker image must use UID/GID 1000");
assert.ok(
  Array.isArray(inspection.RepoDigests) && inspection.RepoDigests.includes(configuration.image),
  "local image metadata does not contain the requested manifest digest",
);

const assignment = JSON.stringify({
  toolRef: { name: "memeloop.runtime.health" },
  arguments: {},
});
const durations = [];
let nextWorker = 0;
async function pool() {
  while (nextWorker < configuration.workers) {
    nextWorker += 1;
    const started = performance.now();
    const output = await command(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "64",
        "--memory",
        "64m",
        "--cpus",
        "0.25",
        "--env",
        `MEMELOOP_TOOL_OPERATION=${assignment}`,
        configuration.image,
      ],
      { timeoutMs: 60_000 },
    );
    const records = output
      .split(/\r?\n/)
      .filter((line) => line.startsWith("MEMELOOP_RESULT "))
      .map((line) => JSON.parse(line.slice("MEMELOOP_RESULT ".length)));
    assert.deepEqual(records, [
      {
        phase: "Completed",
        result: { value: { healthy: true } },
      },
    ]);
    durations.push(Math.max(1, Math.round(performance.now() - started)));
  }
}

const fleetStarted = performance.now();
await Promise.all(Array.from({ length: configuration.concurrency }, () => pool()));
durations.sort((left, right) => left - right);
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    machineId,
    bootId,
    kernel,
    node: process.versions.node,
    dockerServer,
    architecture: inspection.Architecture,
    imageId: inspection.Id,
    workers: configuration.workers,
    wallTimeMs: Math.max(1, Math.round(performance.now() - fleetStarted)),
    p95WorkerMs: durations[Math.ceil(durations.length * 0.95) - 1],
  })}\n`,
);
