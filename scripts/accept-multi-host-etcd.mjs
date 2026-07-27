#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hashHostIdentity, validateMultiHostEtcdInventory } from "./lib/multi-host-acceptance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventoryPath = process.argv[2];
const clientPort = positiveInteger("MEMELOOP_ACCEPTANCE_ETCD_CLIENT_PORT", 32_379);
const peerPort = positiveInteger("MEMELOOP_ACCEPTANCE_ETCD_PEER_PORT", 32_380);
const hostTimeoutMs = positiveInteger(
  "MEMELOOP_ACCEPTANCE_HOST_TIMEOUT_MS",
  15 * 60_000,
  60 * 60_000,
);
const maximumOutputBytes = 512 * 1024;
const runId = `${Date.now().toString(36)}-${randomBytes(5).toString("hex")}`;
const remoteSource = await readFile(
  new URL("./remote/manage-etcd-member.mjs", import.meta.url),
  "utf8",
);
let store;
let startedHosts = [];

if (!inventoryPath) {
  throw new Error("usage: node scripts/accept-multi-host-etcd.mjs <inventory.json>");
}
if (clientPort === peerPort) {
  throw new Error("etcd client and peer ports must differ");
}
const inventory = validateMultiHostEtcdInventory(
  JSON.parse(await readFile(path.resolve(inventoryPath), "utf8")),
);
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "memeloop-multi-host-etcd-"));

function positiveInteger(name, fallback, maximum = 65_535) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isSafeInteger(value) || value < 1024 || value > maximum) {
    throw new Error(`${name} must be an integer between 1024 and ${maximum}`);
  }
  return value;
}

async function command(commandName, arguments_, options = {}) {
  const child = spawn(commandName, arguments_, {
    cwd: options.cwd ?? root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk) => {
    output += chunk.toString("utf8");
    if (Buffer.byteLength(output, "utf8") > maximumOutputBytes) {
      child.kill("SIGKILL");
    }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const timeout = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 60_000);
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

async function createCertificates(hosts) {
  const caKey = path.join(temporaryDirectory, "ca-key.pem");
  const caCertificate = path.join(temporaryDirectory, "ca.pem");
  const serial = path.join(temporaryDirectory, "ca.srl");
  await command("openssl", ["genrsa", "-out", caKey, "2048"]);
  await command("openssl", [
    "req",
    "-x509",
    "-new",
    "-key",
    caKey,
    "-sha256",
    "-days",
    "1",
    "-subj",
    `/CN=memeloop-acceptance-${runId}`,
    "-out",
    caCertificate,
  ]);

  async function sign(name, extendedKeyUsage, subjectAlternativeName) {
    const key = path.join(temporaryDirectory, `${name}-key.pem`);
    const request = path.join(temporaryDirectory, `${name}.csr`);
    const certificate = path.join(temporaryDirectory, `${name}.pem`);
    const extensions = path.join(temporaryDirectory, `${name}.ext`);
    await command("openssl", ["genrsa", "-out", key, "2048"]);
    await command("openssl", ["req", "-new", "-key", key, "-subj", `/CN=${name}`, "-out", request]);
    await writeFile(
      extensions,
      [
        "basicConstraints=CA:FALSE",
        "keyUsage=digitalSignature,keyEncipherment",
        `extendedKeyUsage=${extendedKeyUsage}`,
        ...(subjectAlternativeName ? [`subjectAltName=${subjectAlternativeName}`] : []),
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await command("openssl", [
      "x509",
      "-req",
      "-in",
      request,
      "-CA",
      caCertificate,
      "-CAkey",
      caKey,
      "-CAserial",
      serial,
      "-CAcreateserial",
      "-days",
      "1",
      "-sha256",
      "-extfile",
      extensions,
      "-out",
      certificate,
    ]);
    return {
      certificate: await readFile(certificate),
      privateKey: await readFile(key),
    };
  }

  const serverCertificates = new Map();
  for (const host of hosts) {
    const alternativeName = `${isIP(host.address) ? "IP" : "DNS"}:${host.address}`;
    serverCertificates.set(
      host.name,
      await sign(host.name, "serverAuth,clientAuth", alternativeName),
    );
  }
  return {
    certificateAuthority: await readFile(caCertificate),
    client: await sign("memeloop-controller", "clientAuth"),
    servers: serverCertificates,
  };
}

async function runRemote(host, configuration, { allowFailure = false } = {}) {
  const encoded = Buffer.from(JSON.stringify(configuration)).toString("base64url");
  const injectedSource =
    `globalThis.__MEMELOOP_REMOTE_CONFIGURATION__ = ` +
    `JSON.parse(Buffer.from(${JSON.stringify(encoded)}, "base64url").toString("utf8"));\n` +
    remoteSource;
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
    ],
    {
      cwd: root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.end(injectedSource);
  let output = "";
  const append = (chunk) => {
    output += chunk.toString("utf8");
    if (Buffer.byteLength(output, "utf8") > maximumOutputBytes) {
      child.kill("SIGKILL");
    }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const timeout = setTimeout(() => child.kill("SIGKILL"), hostTimeoutMs);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  clearTimeout(timeout);
  if (code !== 0) {
    if (allowFailure) return undefined;
    throw new Error(
      `${host.name} ${configuration.action} failed with exit code ${String(code)}\n` +
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
  if (!record && !allowFailure) {
    throw new Error(`${host.name} did not emit remote etcd evidence`);
  }
  return record;
}

async function waitFor(check, description, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

let certificates;
const cluster = inventory.hosts
  .map((host) => `${host.name}=https://${host.address}:${peerPort}`)
  .join(",");
const baseConfiguration = (host, action) => {
  const server = certificates.servers.get(host.name);
  return {
    action,
    runId,
    hostName: host.name,
    address: host.address,
    clientPort,
    peerPort,
    cluster,
    ...(action === "start"
      ? {
          certificateAuthority: certificates.certificateAuthority.toString("utf8"),
          certificate: server.certificate.toString("utf8"),
          privateKey: server.privateKey.toString("utf8"),
        }
      : {}),
  };
};

const actor = {
  id: "controller/multi-host-etcd-acceptance",
  kind: "controller",
};
let stoppedForQuorumLoss;
process.stderr.write(`[multi-host-etcd] bounded run id: ${runId}\n`);
try {
  certificates = await createCertificates(inventory.hosts);
  const startResults = await Promise.allSettled(
    inventory.hosts.map(async (host) => {
      const evidence = await runRemote(host, baseConfiguration(host, "start"));
      startedHosts.push(host);
      return { host, evidence };
    }),
  );
  const startFailures = startResults
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (startFailures.length > 0) {
    throw new AggregateError(startFailures, "one or more remote etcd members failed to start");
  }
  const started = startResults.map((result) => result.value);
  assert.equal(
    new Set(started.map(({ evidence }) => evidence.machineId)).size,
    started.length,
    "inventory aliases the same physical machine",
  );
  assert.equal(
    new Set(started.map(({ evidence }) => evidence.bootId)).size,
    started.length,
    "inventory aliases the same running kernel",
  );

  const { EtcdControlStore } = await import("../packages/memeloop-cli/dist/index.js");
  const endpoints = inventory.hosts.map((host) => `https://${host.address}:${clientPort}`);
  store = new EtcdControlStore({
    connection: {
      hosts: endpoints,
      credentials: {
        rootCertificate: certificates.certificateAuthority,
        privateKey: certificates.client.privateKey,
        certChain: certificates.client.certificate,
      },
      dialTimeout: 3_000,
      defaultCallOptions: (context) => (context.isStream ? {} : { deadline: Date.now() + 3_000 }),
    },
    namespace: `/memeloop/multi-host-acceptance/${runId}/`,
    authorizer: { authorize() {} },
  });
  await waitFor(async () => {
    const health = await store.getHealth();
    return health.healthy ? health : false;
  }, "three-member mTLS etcd health");
  const members = await store.listMembers();
  assert.equal(members.length, 3, "etcd cluster does not contain three members");
  assert.ok(members.every((member) => !member.isLearner));

  const beforeFailure = await store.create(actor, {
    apiVersion: "acceptance.memeloop.io/v1alpha1",
    kind: "PhysicalQuorumProbe",
    metadata: { name: "before-host-loss" },
    spec: { stage: "three-hosts" },
  });
  const firstLease = await store.acquireLease(actor, {
    name: "controller/physical-fault-domain",
    holder: "controller-a",
    ttlMs: 300_000,
  });

  const firstStopped = inventory.hosts[0];
  await runRemote(firstStopped, baseConfiguration(firstStopped, "stop"));
  const afterOneHostLoss = await store.create(actor, {
    apiVersion: "acceptance.memeloop.io/v1alpha1",
    kind: "PhysicalQuorumProbe",
    metadata: { name: "after-one-host-loss" },
    spec: { stage: "two-hosts" },
  });

  stoppedForQuorumLoss = inventory.hosts[1];
  await runRemote(stoppedForQuorumLoss, baseConfiguration(stoppedForQuorumLoss, "stop"));
  let quorumLossRejected = false;
  try {
    await store.create(actor, {
      apiVersion: "acceptance.memeloop.io/v1alpha1",
      kind: "PhysicalQuorumProbe",
      metadata: { name: "must-not-commit-with-one-host" },
      spec: { stage: "one-host" },
    });
  } catch (error) {
    quorumLossRejected = error?.code === "UNAVAILABLE";
  }
  assert.ok(quorumLossRejected, "loss of physical quorum did not reject writes");

  await runRemote(stoppedForQuorumLoss, baseConfiguration(stoppedForQuorumLoss, "restart"));
  await waitFor(async () => {
    try {
      const health = await store.getHealth();
      return health.healthy ? health : false;
    } catch {
      return false;
    }
  }, "quorum recovery");
  const afterRecovery = await store.create(actor, {
    apiVersion: "acceptance.memeloop.io/v1alpha1",
    kind: "PhysicalQuorumProbe",
    metadata: { name: "after-quorum-recovery" },
    spec: { stage: "recovered" },
  });
  assert.equal(
    (
      await store.get({
        apiVersion: beforeFailure.apiVersion,
        kind: beforeFailure.kind,
        name: beforeFailure.metadata.name,
      })
    )?.metadata.uid,
    beforeFailure.metadata.uid,
    "pre-failure acknowledged write was lost",
  );
  assert.equal(
    (
      await store.get({
        apiVersion: afterOneHostLoss.apiVersion,
        kind: afterOneHostLoss.kind,
        name: afterOneHostLoss.metadata.name,
      })
    )?.metadata.uid,
    afterOneHostLoss.metadata.uid,
    "write acknowledged after one host loss was lost",
  );
  await store.releaseLease(actor, firstLease);
  const secondLease = await store.acquireLease(actor, {
    name: "controller/physical-fault-domain",
    holder: "controller-b",
    ttlMs: 300_000,
  });
  assert.equal(
    BigInt(secondLease.epoch),
    BigInt(firstLease.epoch) + 1n,
    "fencing epoch did not advance after recovery",
  );
  const snapshotPath = path.join(temporaryDirectory, "physical-etcd.snapshot");
  const snapshot = await store.snapshot(snapshotPath);
  assert.ok((await readFile(snapshotPath)).byteLength > 0);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        kind: "memeloop-multi-host-etcd-evidence/v1",
        transport: "mutual TLS with one-day acceptance certificates",
        members: started.map(({ host, evidence }) => ({
          name: host.name,
          faultDomain: host.faultDomain,
          machineIdentityDigest: hashHostIdentity(evidence.machineId),
          bootIdentityDigest: hashHostIdentity(evidence.bootId),
        })),
        faults: {
          voterOnFirstHostStopped: firstStopped.name,
          writeAfterOneHostLossResourceVersion: afterOneHostLoss.metadata.resourceVersion,
          voterOnSecondHostStopped: stoppedForQuorumLoss.name,
          quorumLossRejected,
          recoveredResourceVersion: afterRecovery.metadata.resourceVersion,
        },
        fencingEpochs: [firstLease.epoch, secondLease.epoch],
        snapshotResourceVersion: snapshot.resourceVersion,
        privacy:
          "SSH targets, network addresses, raw machine identifiers, and key material are excluded",
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await store?.close().catch(() => undefined);
  await Promise.all(
    startedHosts.map(async (host) => {
      await runRemote(host, baseConfiguration(host, "cleanup"), {
        allowFailure: true,
      });
    }),
  );
  await rm(temporaryDirectory, { recursive: true, force: true });
}
