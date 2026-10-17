#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const recoveryTargetMs = readPositiveInteger("MEMELOOP_ACCEPTANCE_RTO_TARGET_MS", 5_000);
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
      label: "protocol-build",
      command: "./node_modules/.bin/tsup",
      arguments_: ["src/index.ts", "--format", "esm", "--dts", "--clean", "--external", "memeloop"],
      cwd: path.join(root, "packages/memeloop-protocol"),
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

await acceptPackagesAndSuites();
await acceptCrashRecovery();

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
];
process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      coveredCriteria,
      evidence,
      residualRisks: [
        "Physical multi-host etcd, Kubernetes, Swarm, remote-CI worker image, and fleet acceptance live in memeloop-online/external-orchestrator.",
        "Linux process RuntimeClasses require a user systemd manager, cgroup v2, bubblewrap, setpriv, and user namespaces; hosts without the complete probe advertise no local process class.",
      ],
    },
    null,
    2,
  )}\n`,
);
