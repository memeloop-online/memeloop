#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  distributeWorkers,
  hashHostIdentity,
  validateCanonicalWorkerImage,
  validateMultiHostInventory,
  validateRemoteEvidence,
} from "./lib/multi-host-acceptance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventoryPath = process.argv[2];
const image = validateCanonicalWorkerImage(process.env.MEMELOOP_ACCEPTANCE_IMAGE);
const fleetSize = positiveInteger("MEMELOOP_ACCEPTANCE_FLEET_SIZE", 100, 100_000);
const perHostConcurrency = positiveInteger("MEMELOOP_ACCEPTANCE_PER_HOST_CONCURRENCY", 8, 1_000);
const timeoutMs = positiveInteger("MEMELOOP_ACCEPTANCE_HOST_TIMEOUT_MS", 15 * 60_000, 60 * 60_000);
const maximumOutputBytes = 512 * 1024;

if (!inventoryPath) {
  throw new Error(
    "usage: MEMELOOP_ACCEPTANCE_IMAGE=<canonical@sha256> node scripts/accept-multi-host-fleet.mjs <inventory.json>",
  );
}

function positiveInteger(name, fallback, maximum) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

const inventory = validateMultiHostInventory(
  JSON.parse(await readFile(path.resolve(inventoryPath), "utf8")),
);
const remoteSource = await readFile(
  new URL("./remote/accept-worker-fleet-host.mjs", import.meta.url),
  "utf8",
);

async function runRemote(host, configuration) {
  const encodedConfiguration = Buffer.from(JSON.stringify(configuration)).toString("base64url");
  const child = spawn(
    "ssh",
    [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ConnectTimeout=10",
      "-p",
      String(host.port),
      "--",
      host.target,
      "node",
      "--input-type=module",
      "-",
      encodedConfiguration,
    ],
    {
      cwd: root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.end(remoteSource);
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
    throw new Error(`${host.name} exceeded the remote output bound`);
  }
  if (code !== 0) {
    throw new Error(
      `${host.name} remote acceptance failed with exit code ${String(code)}\n` +
        output.slice(-16_384),
    );
  }
  const record = output
    .split(/\r?\n/)
    .filter(Boolean)
    .reverse()
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .find((value) => value?.ok === true);
  if (!record) throw new Error(`${host.name} did not emit a valid evidence record`);
  return validateRemoteEvidence(record, configuration);
}

const assignments = distributeWorkers(fleetSize, inventory.hosts);
const started = performance.now();
const results = await Promise.all(
  assignments.map(async ({ host, workers }) => ({
    host,
    evidence: await runRemote(host, {
      image,
      workers,
      concurrency: Math.min(perHostConcurrency, workers),
    }),
  })),
);

const machineIds = new Set(results.map(({ evidence }) => evidence.machineId));
const bootIds = new Set(results.map(({ evidence }) => evidence.bootId));
if (machineIds.size !== results.length) {
  throw new Error(
    "inventory aliases the same machine identity more than once (machine ID collision)",
  );
}
if (bootIds.size !== results.length) {
  throw new Error("inventory aliases the same running kernel more than once (boot ID collision)");
}
// Fault-domain survival probe: exclude each physical host in turn and require
// every remaining domain to execute a new hardened worker successfully.
const survival = [];
for (const excluded of results) {
  const remaining = results.filter((candidate) => candidate.host.name !== excluded.host.name);
  const probes = await Promise.all(
    remaining.map(async ({ host }) => ({
      host: host.name,
      evidence: await runRemote(host, { image, workers: 1, concurrency: 1 }),
    })),
  );
  survival.push({
    excludedHost: excluded.host.name,
    excludedFaultDomain: excluded.host.faultDomain,
    survivingFaultDomains: probes.map(({ host }) => {
      const match = remaining.find((candidate) => candidate.host.name === host);
      return match.host.faultDomain;
    }),
  });
}

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      kind: "memeloop-multi-host-fleet-evidence/v1",
      image,
      fleet: {
        workers: results.reduce((total, result) => total + result.evidence.workers, 0),
        hosts: results.length,
        faultDomains: new Set(results.map((result) => result.host.faultDomain)).size,
        wallTimeMs: Math.max(1, Math.round(performance.now() - started)),
      },
      hosts: results.map(({ host, evidence }) => ({
        name: host.name,
        faultDomain: host.faultDomain,
        machineIdentityDigest: hashHostIdentity(evidence.machineId),
        bootIdentityDigest: hashHostIdentity(evidence.bootId),
        kernel: evidence.kernel,
        node: evidence.node,
        dockerServer: evidence.dockerServer,
        architecture: evidence.architecture,
        imageId: evidence.imageId,
        workers: evidence.workers,
        wallTimeMs: evidence.wallTimeMs,
        p95WorkerMs: evidence.p95WorkerMs,
      })),
      singleHostLossSurvival: survival,
      privacy:
        "SSH targets and raw machine/boot identifiers are intentionally excluded from evidence",
    },
    null,
    2,
  )}\n`,
);
