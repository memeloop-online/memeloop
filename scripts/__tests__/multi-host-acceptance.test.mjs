import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  distributeWorkers,
  hashHostIdentity,
  validateCanonicalWorkerImage,
  validateMultiHostEtcdInventory,
  validateMultiHostInventory,
  validateRemoteEvidence,
} from "../lib/multi-host-acceptance.mjs";

const image = "ghcr.io/linonetwo/memeloop-worker-runtime@sha256:" + "a".repeat(64);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function inventory() {
  return {
    version: 1,
    hosts: [
      {
        name: "worker-a",
        target: "ops@host-a.example",
        address: "10.20.0.11",
        faultDomain: "rack-a",
      },
      {
        name: "worker-b",
        target: "ops@host-b.example",
        address: "10.20.0.12",
        port: 2222,
        faultDomain: "rack-b",
      },
      {
        name: "worker-c",
        target: "host-c.example",
        address: "worker-c.internal",
        faultDomain: "rack-c",
      },
    ],
  };
}

test("validates a bounded three-fault-domain inventory", () => {
  const value = validateMultiHostInventory(inventory());
  assert.equal(value.hosts[0].port, 22);
  assert.equal(value.hosts[1].port, 2222);
  assert.equal(value.hosts.length, 3);
});

test("rejects aliases, shell syntax, unknown fields, and weak fault-domain evidence", () => {
  assert.throws(
    () =>
      validateMultiHostInventory({
        ...inventory(),
        hosts: inventory().hosts.map((host) => ({ ...host, extra: true })),
      }),
    /unknown fields/,
  );
  assert.throws(
    () =>
      validateMultiHostInventory({
        ...inventory(),
        hosts: inventory().hosts.map((host, index) => ({
          ...host,
          target: index === 0 ? "ops@host;reboot" : host.target,
        })),
      }),
    /SSH target/,
  );
  assert.throws(
    () =>
      validateMultiHostInventory({
        ...inventory(),
        hosts: inventory().hosts.map((host) => ({ ...host, faultDomain: "rack-a" })),
      }),
    /three distinct fault domains/,
  );
  assert.throws(
    () =>
      validateMultiHostInventory({
        ...inventory(),
        hosts: inventory().hosts.map((host, index) => ({
          ...host,
          target: index === 1 ? inventory().hosts[0].target : host.target,
          port: index === 1 ? 22 : host.port,
        })),
      }),
    /duplicate SSH endpoint/,
  );
});

test("requires the canonical immutable image coordinate", () => {
  assert.equal(validateCanonicalWorkerImage(image), image);
  assert.throws(
    () => validateCanonicalWorkerImage("ghcr.io/linonetwo/memeloop-worker-runtime:latest"),
    /sha256 manifest digest/,
  );
});

test("requires unique reachable addresses for cross-host etcd", () => {
  const value = validateMultiHostEtcdInventory(inventory());
  assert.equal(value.hosts[0].address, "10.20.0.11");
  assert.throws(
    () =>
      validateMultiHostEtcdInventory({
        ...inventory(),
        hosts: [
          ...inventory().hosts,
          {
            name: "worker-d",
            target: "host-d.example",
            address: "10.20.0.14",
            faultDomain: "rack-d",
          },
        ],
      }),
    /exactly three hosts/,
  );
  assert.throws(
    () =>
      validateMultiHostEtcdInventory({
        ...inventory(),
        hosts: inventory().hosts.map((host, index) => ({
          ...host,
          name: index === 0 ? "worker_a" : host.name,
        })),
      }),
    /letters, digits, and hyphens/,
  );
  assert.throws(
    () =>
      validateMultiHostEtcdInventory({
        ...inventory(),
        hosts: inventory().hosts.map((host) => ({
          ...host,
          address: "10.20.0.11",
        })),
      }),
    /duplicate etcd advertise address/,
  );
  assert.throws(
    () =>
      validateMultiHostEtcdInventory({
        ...inventory(),
        hosts: inventory().hosts.map((host, index) => ({
          ...host,
          ...(index === 0 ? { address: "bad address; reboot" } : {}),
        })),
      }),
    /address must be/,
  );
});

test("distributes every worker exactly once and assigns every host", () => {
  const hosts = validateMultiHostInventory(inventory()).hosts;
  const assignments = distributeWorkers(100, hosts);
  assert.deepEqual(
    assignments.map((assignment) => assignment.workers),
    [34, 33, 33],
  );
  assert.equal(
    assignments.reduce((total, assignment) => total + assignment.workers, 0),
    100,
  );
  assert.throws(() => distributeWorkers(2, hosts), /at least one worker/);
});

test("validates remote evidence and hashes raw machine identities", () => {
  const evidence = {
    ok: true,
    machineId: "machine-identity-a",
    bootId: "boot-identity-a",
    kernel: "6.12.0",
    node: "24.18.0",
    dockerServer: "29.0.0",
    architecture: "amd64",
    imageId: "sha256:content",
    workers: 34,
    wallTimeMs: 1000,
    p95WorkerMs: 250,
  };
  assert.equal(validateRemoteEvidence(evidence, { workers: 34 }), evidence);
  assert.throws(
    () => validateRemoteEvidence({ ...evidence, workers: 33 }, { workers: 34 }),
    /expected 34/,
  );
  assert.match(hashHostIdentity(evidence.machineId), /^[a-f0-9]{64}$/);
  assert.notEqual(hashHostIdentity(evidence.machineId), evidence.machineId);
});

test("runner transports bounded configuration and aggregates privacy-safe evidence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "memeloop-multi-host-test-"));
  const inventoryPath = path.join(directory, "inventory.json");
  const fakeSshPath = path.join(directory, "ssh");
  try {
    await writeFile(inventoryPath, JSON.stringify(inventory()), { mode: 0o600 });
    await writeFile(
      fakeSshPath,
      `#!/usr/bin/env node
const separator = process.argv.indexOf("--");
const target = process.argv[separator + 1];
const encoded = process.argv.at(-1);
const configuration = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
process.stdin.resume();
await new Promise(resolve => process.stdin.once("end", resolve));
const identity = target.replace(/[^a-zA-Z0-9]/g, "-");
process.stdout.write(JSON.stringify({
  ok: true,
  machineId: "machine-" + identity,
  bootId: "boot-id-" + identity,
  kernel: "6.12.0",
  node: "24.18.0",
  dockerServer: "29.0.0",
  architecture: target.includes("host-b") ? "arm64" : "amd64",
  imageId: target.includes("host-b") ? "sha256:arm64" : "sha256:amd64",
  workers: configuration.workers,
  wallTimeMs: 10,
  p95WorkerMs: 5
}) + "\\n");
`,
      { mode: 0o700 },
    );

    const child = spawn(process.execPath, ["scripts/accept-multi-host-fleet.mjs", inventoryPath], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        MEMELOOP_ACCEPTANCE_IMAGE: image,
        MEMELOOP_ACCEPTANCE_FLEET_SIZE: "100",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, output);
    const evidence = JSON.parse(output);
    assert.equal(evidence.ok, true);
    assert.equal(evidence.fleet.workers, 100);
    assert.equal(evidence.fleet.hosts, 3);
    assert.equal(evidence.fleet.faultDomains, 3);
    assert.equal(evidence.singleHostLossSurvival.length, 3);
    assert.ok(
      evidence.hosts.every(
        (host) => !("target" in host) && /^[a-f0-9]{64}$/.test(host.machineIdentityDigest),
      ),
    );
    assert.deepEqual(
      new Set(evidence.hosts.map((host) => host.architecture)),
      new Set(["amd64", "arm64"]),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
