#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createKubectl } from "./lib/kubernetes-acceptance.mjs";
import { hashHostIdentity, validateKubernetesEtcdInventory } from "./lib/multi-host-acceptance.mjs";

const ETCD_IMAGE =
  "quay.io/coreos/etcd:v3.6.11@sha256:6ae247c7666ceec554c51ba1f9bc8dd2212f975370dbd65710c9ca0e36ae1fff";
const inventoryPath = process.argv[2];
if (!inventoryPath) {
  throw new Error("usage: node scripts/accept-kubernetes-etcd.mjs <inventory.json>");
}
const inventory = validateKubernetesEtcdInventory(
  JSON.parse(await readFile(path.resolve(inventoryPath), "utf8")),
);
const runId = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
const namespace = `${inventory.namespacePrefix}-etcd-${runId}`.slice(0, 63).replace(/-+$/, "");
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "memeloop-k8s-etcd-"));
const kubectl = createKubectl();
let namespaceCreated = false;
let store;

async function command(commandName, arguments_) {
  const { spawn } = await import("node:child_process");
  const child = spawn(commandName, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => (output += chunk.toString("utf8")));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) throw new Error(`${commandName} failed\n${output.slice(-16_384)}`);
}

async function createCertificates(nodes) {
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
    `/CN=memeloop-k8s-acceptance-${runId}`,
    "-out",
    caCertificate,
  ]);
  async function sign(name, usage, alternatives = []) {
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
        `extendedKeyUsage=${usage}`,
        ...(alternatives.length > 0 ? [`subjectAltName=${alternatives.join(",")}`] : []),
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
    return { certificate: await readFile(certificate), privateKey: await readFile(key) };
  }
  const alternatives = [
    "DNS:memeloop-etcd",
    ...nodes.flatMap((node, index) => [
      `DNS:etcd-${index}.${namespace}.svc`,
      `DNS:etcd-${index}.${namespace}.svc.cluster.local`,
      `IP:${node.internalIp}`,
    ]),
  ];
  return {
    certificateAuthority: await readFile(caCertificate),
    server: await sign("memeloop-etcd", "serverAuth,clientAuth", alternatives),
    client: await sign("memeloop-controller", "clientAuth"),
  };
}

async function apply(records) {
  await kubectl(["apply", "-f", "-"], {
    input: JSON.stringify({ apiVersion: "v1", kind: "List", items: records }),
  });
}

async function scale(index, replicas) {
  await kubectl(["-n", namespace, "scale", `deployment/etcd-${index}`, `--replicas=${replicas}`]);
  if (replicas === 1) {
    await kubectl(
      ["-n", namespace, "rollout", "status", `deployment/etcd-${index}`, "--timeout=5m"],
      { timeoutMs: 6 * 60_000 },
    );
  } else {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const result = await kubectl([
        "-n",
        namespace,
        "get",
        "pods",
        "-l",
        `memeloop.io/etcd-member=${index}`,
        "-o",
        "json",
      ]);
      if (JSON.parse(result.stdout).items.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`etcd-${index} did not stop`);
  }
}

async function waitFor(check, description, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`timed out waiting for ${description}: ${lastError?.message ?? "not ready"}`);
}

try {
  const nodes = await Promise.all(
    inventory.nodes.map(async (node) => {
      const result = await kubectl(["get", "node", node.name, "-o", "json"]);
      const record = JSON.parse(result.stdout);
      const ready = record.status?.conditions?.some(
        (condition) => condition.type === "Ready" && condition.status === "True",
      );
      assert.ok(ready, `Kubernetes node ${node.name} is not Ready`);
      const internalIp = record.status?.addresses?.find(
        (address) => address.type === "InternalIP",
      )?.address;
      assert.match(internalIp ?? "", /^(?:\d{1,3}\.){3}\d{1,3}$/);
      return {
        ...node,
        internalIp,
        machineId: record.status.nodeInfo.machineID,
        bootId: record.status.nodeInfo.bootID,
      };
    }),
  );
  assert.equal(new Set(nodes.map((node) => node.machineId)).size, 3);
  assert.equal(new Set(nodes.map((node) => node.bootId)).size, 3);
  const certificates = await createCertificates(nodes);
  const cluster = nodes
    .map((_, index) => `etcd-${index}=https://etcd-${index}.${namespace}.svc:2380`)
    .join(",");
  const secretData = {
    "ca.pem": certificates.certificateAuthority.toString("base64"),
    "server.pem": certificates.server.certificate.toString("base64"),
    "server-key.pem": certificates.server.privateKey.toString("base64"),
  };

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
  const resources = [
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "etcd-tls", namespace },
      type: "Opaque",
      data: secretData,
    },
  ];
  for (const [index, node] of nodes.entries()) {
    const labels = {
      "app.kubernetes.io/name": "memeloop-etcd-acceptance",
      "memeloop.io/acceptance-run": runId,
      "memeloop.io/etcd-member": String(index),
    };
    resources.push(
      {
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: { name: `etcd-${index}-data`, namespace },
        spec: {
          accessModes: ["ReadWriteOnce"],
          storageClassName:
            process.env.MEMELOOP_ACCEPTANCE_KUBERNETES_STORAGE_CLASS ?? "local-path",
          resources: { requests: { storage: "128Mi" } },
        },
      },
      {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: `etcd-${index}`, namespace, labels },
        spec: {
          type: "NodePort",
          externalTrafficPolicy: "Local",
          selector: labels,
          ports: [
            { name: "client", port: 2379, targetPort: 2379 },
            { name: "peer", port: 2380, targetPort: 2380 },
          ],
        },
      },
      {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: `etcd-${index}`, namespace, labels },
        spec: {
          replicas: 1,
          strategy: { type: "Recreate" },
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              automountServiceAccountToken: false,
              enableServiceLinks: false,
              nodeSelector: { "kubernetes.io/hostname": node.name },
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 1000,
                runAsGroup: 1000,
                fsGroup: 1000,
                seccompProfile: { type: "RuntimeDefault" },
              },
              containers: [
                {
                  name: "etcd",
                  image: ETCD_IMAGE,
                  imagePullPolicy: "IfNotPresent",
                  command: ["/usr/local/bin/etcd"],
                  args: [
                    "--name",
                    `etcd-${index}`,
                    "--data-dir",
                    "/var/lib/etcd",
                    "--listen-client-urls",
                    "https://0.0.0.0:2379",
                    "--advertise-client-urls",
                    `https://etcd-${index}.${namespace}.svc:2379`,
                    "--listen-peer-urls",
                    "https://0.0.0.0:2380",
                    "--initial-advertise-peer-urls",
                    `https://etcd-${index}.${namespace}.svc:2380`,
                    "--initial-cluster",
                    cluster,
                    "--initial-cluster-state",
                    "new",
                    "--client-cert-auth",
                    "--trusted-ca-file",
                    "/tls/ca.pem",
                    "--cert-file",
                    "/tls/server.pem",
                    "--key-file",
                    "/tls/server-key.pem",
                    "--peer-client-cert-auth",
                    "--peer-trusted-ca-file",
                    "/tls/ca.pem",
                    "--peer-cert-file",
                    "/tls/server.pem",
                    "--peer-key-file",
                    "/tls/server-key.pem",
                  ],
                  ports: [
                    { name: "client", containerPort: 2379 },
                    { name: "peer", containerPort: 2380 },
                  ],
                  readinessProbe: {
                    tcpSocket: { port: "client" },
                    initialDelaySeconds: 2,
                    periodSeconds: 2,
                  },
                  resources: {
                    requests: { cpu: "25m", memory: "64Mi" },
                    limits: { cpu: "500m", memory: "256Mi" },
                  },
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    capabilities: { drop: ["ALL"] },
                    readOnlyRootFilesystem: true,
                  },
                  volumeMounts: [
                    { name: "data", mountPath: "/var/lib/etcd" },
                    { name: "tls", mountPath: "/tls", readOnly: true },
                  ],
                },
              ],
              volumes: [
                { name: "data", persistentVolumeClaim: { claimName: `etcd-${index}-data` } },
                { name: "tls", secret: { secretName: "etcd-tls", defaultMode: 0o400 } },
              ],
            },
          },
        },
      },
    );
  }
  await apply(resources);
  await Promise.all(nodes.map((_, index) => scale(index, 1)));

  const services = await Promise.all(
    nodes.map(async (node, index) => {
      const result = await kubectl([
        "-n",
        namespace,
        "get",
        "service",
        `etcd-${index}`,
        "-o",
        "json",
      ]);
      const service = JSON.parse(result.stdout);
      const nodePort = service.spec.ports.find((port) => port.name === "client")?.nodePort;
      assert.ok(Number.isInteger(nodePort));
      return `https://${node.internalIp}:${nodePort}`;
    }),
  );
  const { EtcdControlStore } = await import("../packages/memeloop-cli/dist/index.js");
  store = new EtcdControlStore({
    connection: {
      hosts: services,
      grpcOptions: {
        "grpc.default_authority": "memeloop-etcd",
        "grpc.ssl_target_name_override": "memeloop-etcd",
      },
      credentials: {
        rootCertificate: certificates.certificateAuthority,
        privateKey: certificates.client.privateKey,
        certChain: certificates.client.certificate,
      },
      dialTimeout: 3_000,
      defaultCallOptions: (context) => (context.isStream ? {} : { deadline: Date.now() + 3_000 }),
    },
    namespace: `/memeloop/kubernetes-acceptance/${runId}/`,
    authorizer: { authorize() {} },
  });
  await waitFor(async () => (await store.getHealth()).healthy, "three-node etcd health");
  assert.equal((await store.listMembers()).length, 3);
  const actor = { id: "controller/kubernetes-acceptance", kind: "controller" };
  const beforeFailure = await store.create(actor, {
    apiVersion: "acceptance.memeloop.io/v1alpha1",
    kind: "PhysicalQuorumProbe",
    metadata: { name: "before-node-loss" },
    spec: { stage: "three-nodes" },
  });
  const firstLease = await store.acquireLease(actor, {
    name: "controller/kubernetes-fault-domain",
    holder: "controller-a",
    ttlMs: 300_000,
  });
  await scale(0, 0);
  const afterOneLoss = await store.create(actor, {
    apiVersion: "acceptance.memeloop.io/v1alpha1",
    kind: "PhysicalQuorumProbe",
    metadata: { name: "after-one-node-loss" },
    spec: { stage: "two-nodes" },
  });
  await scale(1, 0);
  let quorumLossRejected = false;
  try {
    await store.create(actor, {
      apiVersion: "acceptance.memeloop.io/v1alpha1",
      kind: "PhysicalQuorumProbe",
      metadata: { name: "must-not-commit" },
      spec: { stage: "one-node" },
    });
  } catch (error) {
    quorumLossRejected = error?.code === "UNAVAILABLE";
  }
  assert.ok(quorumLossRejected, "loss of Kubernetes etcd quorum did not reject writes");
  await scale(1, 1);
  await waitFor(async () => {
    try {
      return (await store.getHealth()).healthy;
    } catch {
      return false;
    }
  }, "Kubernetes etcd quorum recovery");
  const afterRecovery = await store.create(actor, {
    apiVersion: "acceptance.memeloop.io/v1alpha1",
    kind: "PhysicalQuorumProbe",
    metadata: { name: "after-recovery" },
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
  );
  assert.equal(
    (
      await store.get({
        apiVersion: afterOneLoss.apiVersion,
        kind: afterOneLoss.kind,
        name: afterOneLoss.metadata.name,
      })
    )?.metadata.uid,
    afterOneLoss.metadata.uid,
  );
  await store.releaseLease(actor, firstLease);
  const secondLease = await store.acquireLease(actor, {
    name: "controller/kubernetes-fault-domain",
    holder: "controller-b",
    ttlMs: 300_000,
  });
  assert.equal(BigInt(secondLease.epoch), BigInt(firstLease.epoch) + 1n);
  const snapshotPath = path.join(temporaryDirectory, "kubernetes-etcd.snapshot");
  const snapshot = await store.snapshot(snapshotPath);
  assert.ok((await readFile(snapshotPath)).byteLength > 0);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        kind: "memeloop-kubernetes-etcd-evidence/v1",
        transport: "Kubernetes NodePort with mutual TLS and one-day certificates",
        members: nodes.map((node) => ({
          name: node.name,
          faultDomain: node.faultDomain,
          machineIdentityDigest: hashHostIdentity(node.machineId),
          bootIdentityDigest: hashHostIdentity(node.bootId),
        })),
        faults: {
          voterOnFirstNodeStopped: nodes[0].name,
          writeAfterOneNodeLossResourceVersion: afterOneLoss.metadata.resourceVersion,
          voterOnSecondNodeStopped: nodes[1].name,
          quorumLossRejected,
          recoveredResourceVersion: afterRecovery.metadata.resourceVersion,
        },
        fencingEpochs: [firstLease.epoch, secondLease.epoch],
        snapshotResourceVersion: snapshot.resourceVersion,
        privacy: "node addresses, raw machine identifiers, and key material are excluded",
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await store?.close().catch(() => undefined);
  if (namespaceCreated) {
    await kubectl(["delete", "namespace", namespace, "--wait=false"], {
      allowFailure: true,
      timeoutMs: 60_000,
    });
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}
