#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const image = process.env.MEMELOOP_ACCEPTANCE_IMAGE ?? "memeloop/worker-runtime:0.0.1-auth";
const fleetSize = readPositiveInteger("MEMELOOP_ACCEPTANCE_FLEET_SIZE", 100);
const fleetConcurrency = readPositiveInteger("MEMELOOP_ACCEPTANCE_FLEET_CONCURRENCY", 25);
const recoveryTargetMs = readPositiveInteger("MEMELOOP_ACCEPTANCE_RTO_TARGET_MS", 5_000);
const multiHostInventory = process.env.MEMELOOP_ACCEPTANCE_MULTI_HOST_INVENTORY;
const maximumOutputBytes = 2 * 1024 * 1024;
const evidence = {};

function readPositiveInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function commandFailure(label, code, output) {
  const tail = output.slice(-16_384);
  return new Error(`${label} failed with exit code ${String(code)}\n${tail}`);
}

async function run(label, command, arguments_, options = {}) {
  const started = performance.now();
  const child = spawn(command, arguments_, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let stdout = "";
  let stderr = "";
  const append = (stream) => (chunk) => {
    const text = chunk.toString("utf8");
    output += text;
    if (stream === "stdout") stdout += text;
    else stderr += text;
    if (Buffer.byteLength(output, "utf8") > maximumOutputBytes) {
      child.kill("SIGKILL");
    }
  };
  child.stdout.on("data", append("stdout"));
  child.stderr.on("data", append("stderr"));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (Buffer.byteLength(output, "utf8") > maximumOutputBytes) {
    throw new Error(`${label} exceeded the ${maximumOutputBytes}-byte output bound`);
  }
  if (code !== 0) throw commandFailure(label, code, output);
  return {
    durationMs: Math.round(performance.now() - started),
    output,
    stdout,
    stderr,
  };
}

async function acceptPackagesAndSuites() {
  const commands = [
    {
      label: "core-loop-source-generation",
      command: process.execPath,
      arguments_: ["scripts/generate-loop-sources.mjs"],
      cwd: path.join(root, "packages/memeloop"),
    },
    {
      label: "core-profile-source-generation",
      command: process.execPath,
      arguments_: ["scripts/generate-profile-sources.mjs"],
      cwd: path.join(root, "packages/memeloop"),
    },
    {
      label: "core-build",
      command: "./node_modules/.bin/tsup",
      arguments_: [],
      cwd: path.join(root, "packages/memeloop"),
    },
    {
      label: "cli-build",
      command: "./node_modules/.bin/tsup",
      arguments_: [],
      cwd: path.join(root, "packages/memeloop-cli"),
    },
    {
      label: "libp2p-adapter-build",
      command: "./node_modules/.bin/tsc",
      arguments_: ["-p", "tsconfig.build.json"],
      cwd: path.join(root, "packages/memeloop-libp2p"),
    },
    {
      label: "k8s-build",
      command: "./node_modules/.bin/tsc",
      arguments_: ["-p", "tsconfig.build.json"],
      cwd: path.join(root, "packages/memeloop-k8s"),
    },
    {
      label: "swarm-build",
      command: "./node_modules/.bin/tsc",
      arguments_: ["-p", "tsconfig.build.json"],
      cwd: path.join(root, "packages/memeloop-swarm"),
    },
    {
      label: "protocol-build",
      command: "./node_modules/.bin/tsup",
      arguments_: ["src/index.ts", "--format", "esm", "--dts", "--clean", "--external", "memeloop"],
      cwd: path.join(root, "packages/memeloop-protocol"),
    },
    {
      label: "worker-build",
      command: process.execPath,
      arguments_: ["--check", "src/entrypoint.mjs"],
      cwd: path.join(root, "packages/memeloop-worker-runtime"),
    },
    {
      label: "portable-boundary",
      command: process.execPath,
      arguments_: ["scripts/check-portable-boundaries.mjs"],
    },
    {
      label: "packed-sdk-manifests",
      command: process.execPath,
      arguments_: ["scripts/check-packed-packages.mjs"],
    },
    {
      label: "core-suite",
      command: "./node_modules/.bin/vitest",
      arguments_: ["run"],
      cwd: path.join(root, "packages/memeloop"),
    },
    {
      label: "cli-suite",
      command: "./node_modules/.bin/vitest",
      arguments_: ["run"],
      cwd: path.join(root, "packages/memeloop-cli"),
    },
    {
      label: "libp2p-adapter-suite",
      command: "./node_modules/.bin/vitest",
      arguments_: ["run"],
      cwd: path.join(root, "packages/memeloop-libp2p"),
    },
    {
      label: "k8s-suite",
      command: "./node_modules/.bin/vitest",
      arguments_: ["run"],
      cwd: path.join(root, "packages/memeloop-k8s"),
    },
    {
      label: "swarm-suite",
      command: "./node_modules/.bin/vitest",
      arguments_: ["run"],
      cwd: path.join(root, "packages/memeloop-swarm"),
    },
    {
      label: "worker-suite",
      command: "./node_modules/.bin/vitest",
      arguments_: ["run"],
      cwd: path.join(root, "packages/memeloop-worker-runtime"),
    },
    {
      label: "protocol-suite",
      command: "./node_modules/.bin/vitest",
      arguments_: ["run"],
      cwd: path.join(root, "packages/memeloop-protocol"),
    },
    {
      label: "tauri-suite",
      command: "cargo",
      arguments_: ["test", "--quiet"],
      cwd: path.join(root, "packages/memeloop-protocol-rust"),
    },
    {
      label: "host-acceptance",
      command: process.execPath,
      arguments_: ["scripts/accept-host-integration.mjs"],
    },
    {
      label: "etcd-quorum-acceptance",
      command: process.execPath,
      arguments_: ["scripts/accept-etcd-quorum.mjs"],
    },
  ];
  for (const item of commands) {
    const result = await run(
      item.label,
      item.command,
      item.arguments_,
      item.cwd ? { cwd: item.cwd } : {},
    );
    evidence[item.label] = { passed: true, durationMs: result.durationMs };
  }
}

async function acceptCrashRecovery() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "memeloop-final-recovery-"));
  const databasePath = path.join(directory, "control.db");
  const childSource = `
    import { SQLiteControlStore } from ${JSON.stringify(
      new URL("../packages/memeloop-cli/dist/index.js", import.meta.url).href,
    )};
    const store = new SQLiteControlStore({
      filename: process.env.MEMELOOP_RECOVERY_DB,
      authorizer: { authorize() {} },
    });
    await store.create(
      { id: 'controller/recovery-writer', kind: 'controller' },
      {
        apiVersion: 'execution.memeloop.io/v1alpha1',
        kind: 'AgentWorkload',
        metadata: { name: 'acknowledged-before-kill', namespace: 'acceptance' },
        spec: { lifecycle: 'job', runtimeClass: 'restricted-process', trust: 'restricted' },
      },
    );
    process.stdout.write('ACK\\n');
    setInterval(() => {}, 60_000);
  `;
  let writer;
  try {
    writer = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
      cwd: root,
      env: { ...process.env, MEMELOOP_RECOVERY_DB: databasePath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    writer.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    await new Promise((resolve, reject) => {
      let stdout = "";
      const timeout = setTimeout(() => {
        reject(new Error(`recovery writer did not acknowledge in time: ${stderr}`));
      }, 10_000);
      writer.once("error", reject);
      writer.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
        if (stdout.includes("ACK\n")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    writer.kill("SIGKILL");
    await new Promise((resolve) => writer.once("close", resolve));
    writer = undefined;

    const started = performance.now();
    const { SQLiteControlStore } = await import("../packages/memeloop-cli/dist/index.js");
    const store = new SQLiteControlStore({
      filename: databasePath,
      authorizer: { authorize() {} },
    });
    const recovered = await store.get({
      apiVersion: "execution.memeloop.io/v1alpha1",
      kind: "AgentWorkload",
      namespace: "acceptance",
      name: "acknowledged-before-kill",
    });
    const recoveryMs = Math.round(performance.now() - started);
    await store.close();
    assert.ok(recovered, "acknowledged resource was lost after SIGKILL");
    assert.ok(
      recoveryMs <= recoveryTargetMs,
      `SQLite recovery took ${recoveryMs}ms (target ${recoveryTargetMs}ms)`,
    );
    evidence.recovery = {
      passed: true,
      observedRpoWrites: 0,
      observedRtoMs: recoveryMs,
      targetRtoMs: recoveryTargetMs,
      fault: "SIGKILL after acknowledged SQLite transaction",
    };
  } finally {
    writer?.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
}

async function acceptWorkerFleet() {
  const inspection = await run("worker-image-inspection", "docker", [
    "image",
    "inspect",
    image,
    "--format",
    "{{json .Config.User}}",
  ]);
  assert.equal(JSON.parse(inspection.output.trim()), "1000:1000");

  const assignment = JSON.stringify({
    toolRef: { name: "memeloop.runtime.health" },
    arguments: {},
  });
  const durations = [];
  let nextWorker = 0;
  async function workerPool() {
    while (nextWorker < fleetSize) {
      const worker = nextWorker;
      nextWorker += 1;
      const result = await run(`worker-fleet-${worker}`, "docker", [
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
        image,
      ]);
      const records = result.output
        .split(/\r?\n/)
        .filter((line) => line.startsWith("MEMELOOP_RESULT "))
        .map((line) => JSON.parse(line.slice("MEMELOOP_RESULT ".length)));
      assert.deepEqual(records, [
        {
          phase: "Completed",
          result: { value: { healthy: true } },
        },
      ]);
      durations.push(result.durationMs);
    }
  }
  const started = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(fleetConcurrency, fleetSize) }, () => workerPool()),
  );
  durations.sort((left, right) => left - right);
  evidence["worker-fleet"] = {
    passed: true,
    workers: fleetSize,
    concurrency: Math.min(fleetConcurrency, fleetSize),
    wallTimeMs: Math.round(performance.now() - started),
    p95WorkerMs: durations[Math.ceil(durations.length * 0.95) - 1],
    image,
  };
}

async function acceptMultiHostFleet() {
  if (!multiHostInventory) return;
  const result = await run("multi-host-worker-fleet", process.execPath, [
    "scripts/accept-multi-host-fleet.mjs",
    multiHostInventory,
  ]);
  const record = JSON.parse(result.stdout);
  assert.equal(record.ok, true, "multi-host fleet did not report success");
  assert.ok(record.fleet?.workers >= 100, "multi-host fleet ran fewer than 100 workers");
  assert.ok(
    record.fleet?.hosts >= 3 && record.fleet?.faultDomains >= 3,
    "multi-host fleet did not span three physical fault domains",
  );
  evidence["multi-host-worker-fleet"] = {
    passed: true,
    durationMs: result.durationMs,
    workers: record.fleet.workers,
    hosts: record.fleet.hosts,
    faultDomains: record.fleet.faultDomains,
    image: record.image,
  };
}

async function acceptMultiHostEtcd() {
  if (!multiHostInventory) return;
  const result = await run("multi-host-etcd-quorum", process.execPath, [
    "scripts/accept-multi-host-etcd.mjs",
    multiHostInventory,
  ]);
  const record = JSON.parse(result.stdout);
  assert.equal(record.ok, true, "multi-host etcd did not report success");
  assert.equal(record.members?.length, 3, "multi-host etcd did not report three voters");
  assert.equal(
    new Set(record.members.map((member) => member.faultDomain)).size,
    3,
    "multi-host etcd did not span three physical fault domains",
  );
  assert.equal(
    record.faults?.quorumLossRejected,
    true,
    "multi-host etcd did not reject a write after quorum loss",
  );
  evidence["multi-host-etcd-quorum"] = {
    passed: true,
    durationMs: result.durationMs,
    hosts: record.members.length,
    faultDomains: new Set(record.members.map((member) => member.faultDomain)).size,
    quorumLossRejected: record.faults.quorumLossRejected,
    fencingEpochs: record.fencingEpochs,
    snapshotResourceVersion: record.snapshotResourceVersion,
  };
}

await acceptPackagesAndSuites();
await acceptCrashRecovery();
await acceptWorkerFleet();
await acceptMultiHostFleet();
await acceptMultiHostEtcd();

const coveredCriteria = [
  "portability",
  "package",
  "controller",
  "scheduler",
  "runtime",
  "model",
  "tool",
  "network",
  "storage",
  "credential",
  "artifact",
  "hostile-worker",
  "promotion",
  "quorum",
  "hundred-worker-fleet",
  ...(multiHostInventory ? ["physical-fault-domains"] : []),
];
process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      coveredCriteria,
      evidence,
      residualRisks: [
        ...(multiHostInventory
          ? []
          : [
              "The real etcd drill exercises three isolated members on one Docker host; set MEMELOOP_ACCEPTANCE_MULTI_HOST_INVENTORY to require a three-machine mTLS quorum drill.",
              "The hundred-worker fleet uses isolated containers on one Docker host; set MEMELOOP_ACCEPTANCE_MULTI_HOST_INVENTORY to require separate physical fault domains.",
            ]),
        "Linux process RuntimeClasses require a user systemd manager, cgroup v2, bubblewrap, setpriv, and user namespaces; hosts without the complete probe advertise no local process class.",
        "Published-image Swarm/K3s authenticated profile acceptance remains pending until the GHCR workflow runs.",
      ],
    },
    null,
    2,
  )}\n`,
);
