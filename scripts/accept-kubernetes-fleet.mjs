#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  distributeWorkers,
  hashHostIdentity,
  validateCanonicalWorkerImage,
  validateKubernetesInventory,
} from "./lib/multi-host-acceptance.mjs";
import {
  createKubectl,
  validateCompletedWorkerPods,
  workerJob,
} from "./lib/kubernetes-acceptance.mjs";

const inventoryPath = process.argv[2];
if (!inventoryPath) {
  throw new Error(
    "usage: MEMELOOP_ACCEPTANCE_IMAGE=<canonical@sha256> node scripts/accept-kubernetes-fleet.mjs <inventory.json>",
  );
}
const image = validateCanonicalWorkerImage(process.env.MEMELOOP_ACCEPTANCE_IMAGE);
const fleetSize = positiveInteger("MEMELOOP_ACCEPTANCE_FLEET_SIZE", 100, 100_000);
const inventory = validateKubernetesInventory(
  JSON.parse(await readFile(path.resolve(inventoryPath), "utf8")),
);
const runId = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
const namespace = `${inventory.namespacePrefix}-${runId}`.slice(0, 63).replace(/-+$/, "");
const kubectl = createKubectl();
const started = performance.now();
let namespaceCreated = false;
const dockerConfigPath = process.env.MEMELOOP_ACCEPTANCE_DOCKER_CONFIG;
const imagePullSecret = dockerConfigPath ? "worker-registry-auth" : undefined;

function positiveInteger(name, fallback, maximum) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

async function apply(records) {
  await kubectl(["apply", "-f", "-"], {
    input: JSON.stringify({ apiVersion: "v1", kind: "List", items: records }),
  });
}

async function waitForJob(name) {
  await kubectl(
    ["-n", namespace, "wait", "--for=condition=complete", `job/${name}`, "--timeout=15m"],
    { timeoutMs: 16 * 60_000 },
  );
}

async function inspectJob(name, node, workers) {
  const result = await kubectl([
    "-n",
    namespace,
    "get",
    "pods",
    "-l",
    `job-name=${name}`,
    "-o",
    "json",
  ]);
  const pods = validateCompletedWorkerPods(JSON.parse(result.stdout), {
    nodeName: node.name,
    workers,
  });
  for (const pod of pods) {
    const logs = await kubectl(["-n", namespace, "logs", pod.metadata.name, "-c", "worker"]);
    const records = logs.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("MEMELOOP_RESULT "))
      .map((line) => JSON.parse(line.slice("MEMELOOP_RESULT ".length)));
    assert.deepEqual(records, [{ phase: "Completed", result: { value: { healthy: true } } }]);
  }
}

async function registrySecret() {
  if (!dockerConfigPath) return undefined;
  const resolved = path.resolve(dockerConfigPath);
  const metadata = await stat(resolved);
  assert.ok(metadata.isFile(), "MEMELOOP_ACCEPTANCE_DOCKER_CONFIG must name a regular file");
  assert.equal(
    metadata.mode & 0o077,
    0,
    "MEMELOOP_ACCEPTANCE_DOCKER_CONFIG must not be accessible by group or other users",
  );
  const contents = await readFile(resolved);
  assert.ok(contents.byteLength > 1 && contents.byteLength <= 256 * 1024);
  JSON.parse(contents.toString("utf8"));
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: imagePullSecret, namespace },
    type: "kubernetes.io/dockerconfigjson",
    data: { ".dockerconfigjson": contents.toString("base64") },
  };
}

try {
  const requestedNodes = await Promise.all(
    inventory.nodes.map(async (node) => {
      const result = await kubectl(["get", "node", node.name, "-o", "json"]);
      const record = JSON.parse(result.stdout);
      const ready = record.status?.conditions?.some(
        (condition) => condition.type === "Ready" && condition.status === "True",
      );
      assert.ok(ready, `Kubernetes node ${node.name} is not Ready`);
      assert.equal(
        record.metadata?.labels?.["kubernetes.io/hostname"],
        node.name,
        `node ${node.name} hostname label does not match its inventory name`,
      );
      const machineId = record.status?.nodeInfo?.machineID;
      const bootId = record.status?.nodeInfo?.bootID;
      assert.ok(typeof machineId === "string" && machineId.length >= 8);
      assert.ok(typeof bootId === "string" && bootId.length >= 8);
      return { node, record, machineId, bootId };
    }),
  );
  assert.equal(
    new Set(requestedNodes.map((entry) => entry.machineId)).size,
    requestedNodes.length,
    "inventory aliases the same Kubernetes machine",
  );
  assert.equal(
    new Set(requestedNodes.map((entry) => entry.bootId)).size,
    requestedNodes.length,
    "inventory aliases the same running kernel",
  );

  await apply([
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: namespace,
        labels: {
          "app.kubernetes.io/managed-by": "memeloop-acceptance",
          "memeloop.io/acceptance-run": runId,
          "pod-security.kubernetes.io/enforce": "restricted",
          "pod-security.kubernetes.io/enforce-version": "latest",
        },
      },
    },
  ]);
  namespaceCreated = true;
  const pullSecret = await registrySecret();
  if (pullSecret) await apply([pullSecret]);

  const assignments = distributeWorkers(fleetSize, inventory.nodes);
  const jobs = assignments.map(({ host: node, workers }, index) =>
    workerJob({
      name: `fleet-${index}`,
      namespace,
      nodeName: node.name,
      completions: workers,
      image,
      runId,
      imagePullSecret,
    }),
  );
  await apply(jobs);
  await Promise.all(jobs.map((job) => waitForJob(job.metadata.name)));
  await Promise.all(
    assignments.map(({ host, workers }, index) => inspectJob(`fleet-${index}`, host, workers)),
  );

  const survival = [];
  for (const excluded of inventory.nodes) {
    const remaining = inventory.nodes.filter((node) => node.name !== excluded.name);
    const probes = remaining.map((node, index) =>
      workerJob({
        name: `survive-${inventory.nodes.indexOf(excluded)}-${index}`,
        namespace,
        nodeName: node.name,
        completions: 1,
        image,
        runId,
        imagePullSecret,
      }),
    );
    await apply(probes);
    await Promise.all(probes.map((job) => waitForJob(job.metadata.name)));
    await Promise.all(
      probes.map((job, index) => inspectJob(job.metadata.name, remaining[index], 1)),
    );
    survival.push({
      excludedNode: excluded.name,
      excludedFaultDomain: excluded.faultDomain,
      survivingFaultDomains: remaining.map((node) => node.faultDomain),
    });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        kind: "memeloop-kubernetes-fleet-evidence/v1",
        image,
        fleet: {
          workers: fleetSize,
          hosts: inventory.nodes.length,
          faultDomains: new Set(inventory.nodes.map((node) => node.faultDomain)).size,
          wallTimeMs: Math.max(1, Math.round(performance.now() - started)),
        },
        nodes: requestedNodes.map(({ node, record, machineId, bootId }) => ({
          name: node.name,
          faultDomain: node.faultDomain,
          machineIdentityDigest: hashHostIdentity(machineId),
          bootIdentityDigest: hashHostIdentity(bootId),
          kernel: record.status.nodeInfo.kernelVersion,
          architecture: record.status.nodeInfo.architecture,
          containerRuntime: record.status.nodeInfo.containerRuntimeVersion,
          kubelet: record.status.nodeInfo.kubeletVersion,
        })),
        singleNodeExclusionSurvival: survival,
        privacy: "raw Kubernetes machine and boot identifiers are intentionally excluded",
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (namespaceCreated) {
    await kubectl(["delete", "namespace", namespace, "--wait=false"], {
      allowFailure: true,
      timeoutMs: 60_000,
    });
  }
}
