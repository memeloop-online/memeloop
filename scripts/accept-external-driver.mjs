import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const backend = process.argv[2];
if (backend !== "swarm" && backend !== "k8s") {
  throw new Error("usage: node scripts/accept-external-driver.mjs <swarm|k8s>");
}

const image = process.env.MEMELOOP_ACCEPTANCE_IMAGE ?? "memeloop/worker-runtime:0.0.1";
const timeoutMs = Number.parseInt(process.env.MEMELOOP_ACCEPTANCE_TIMEOUT_MS ?? "60000", 10);
const gatewayHost = process.env.MEMELOOP_ACCEPTANCE_GATEWAY_HOST;
const swarmRegistryAuthFile = process.env.MEMELOOP_SWARM_REGISTRY_AUTH_FILE;
const k8sDockerConfigFile = process.env.MEMELOOP_K8S_DOCKER_CONFIG_FILE;
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const k8sImagePullSecret =
  process.env.MEMELOOP_K8S_IMAGE_PULL_SECRET ??
  (k8sDockerConfigFile ? `memeloop-pull-${suffix}` : undefined);
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
  throw new Error("MEMELOOP_ACCEPTANCE_TIMEOUT_MS must be at least 1000");
}
if (
  process.env.MEMELOOP_REQUIRE_CANONICAL_IMAGE === "true" &&
  !/^ghcr\.io\/linonetwo\/memeloop-worker-runtime@sha256:[a-f0-9]{64}$/.test(image)
) {
  throw new Error(
    "MEMELOOP_ACCEPTANCE_IMAGE must be the canonical GHCR coordinate pinned by sha256 digest",
  );
}

const driver =
  backend === "swarm"
    ? new (await import("../packages/memeloop-swarm/dist/index.js")).SwarmOrchestrationDriver({
        defaultWorkloadImage: image,
        defaultToolImage: image,
        ...(swarmRegistryAuthFile ? { registryAuthFile: swarmRegistryAuthFile } : {}),
      })
    : new (await import("../packages/memeloop-k8s/dist/index.js")).KubernetesOrchestrationDriver({
        baseUrl:
          process.env.MEMELOOP_K8S_BASE_URL ??
          (() => {
            throw new Error("MEMELOOP_K8S_BASE_URL is required for k8s acceptance");
          })(),
        ...(process.env.MEMELOOP_K8S_TOKEN_FILE
          ? { bearerTokenFile: process.env.MEMELOOP_K8S_TOKEN_FILE }
          : {}),
        ...(process.env.MEMELOOP_K8S_CA_FILE
          ? { caCertificateFile: process.env.MEMELOOP_K8S_CA_FILE }
          : {}),
        defaultWorkloadImage: image,
        defaultToolImage: image,
        ...(k8sImagePullSecret ? { imagePullSecrets: [k8sImagePullSecret] } : {}),
      });

const normalize = (source) =>
  source
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim() + "\n";
const source = normalize(
  `export default async function* acceptance() { yield { type: "message", data: "real-${backend}-ok" }; }`,
);
const scriptReference = `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`;
const metadata = (name) => ({
  name,
  namespace: "default",
  uid: `${name}-${suffix}`,
  generation: 1,
  resourceVersion: "1",
  creationTimestamp: new Date().toISOString(),
});
const workload = {
  apiVersion: "workload.memeloop.io/v1alpha1",
  kind: "AgentWorkload",
  metadata: metadata(`accept-${backend}-workload`),
  spec: { scriptReference, completionPolicy: "complete" },
};
const operation = {
  apiVersion: "execution.memeloop.io/v1alpha1",
  kind: "ToolOperation",
  metadata: metadata(`accept-${backend}-tool`),
  spec: {
    toolRef: {
      apiVersion: "tools.memeloop.io/v1alpha1",
      kind: "Tool",
      name: "memeloop.runtime.echo",
    },
    arguments: { accepted: true },
    effect: "read",
    idempotencyKey: `accept-${backend}-${suffix}`,
  },
};
const actor = {
  id: `controller/external-driver-acceptance-${backend}`,
  kind: "controller",
};

async function waitTerminal(readStatus, externalId) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await readStatus(externalId);
    if (["Succeeded", "Failed", "Cancelled"].includes(status.phase)) return status;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timeout waiting for external resource '${externalId}'`);
}

async function acceptAuthenticatedProfile() {
  if (!gatewayHost) return undefined;
  const {
    createAgentRunManifest,
    createAgentWorkloadManifest,
    createWorkerEnrollmentManifest,
    WORKER_PROTOCOL_VERSION,
  } = await import("../packages/memeloop/dist/index.js");
  const { createNodeRuntime, hashWorkerBootstrapToken } =
    await import("../packages/memeloop-cli/dist/index.js");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `memeloop-${backend}-profile-`));
  const tlsKeyPath = path.join(dataDir, "gateway-key.pem");
  const tlsCertificatePath = path.join(dataDir, "gateway-certificate.pem");
  const subjectAltName = net.isIP(gatewayHost) ? `IP:${gatewayHost}` : `DNS:${gatewayHost}`;
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ed25519",
    "-nodes",
    "-keyout",
    tlsKeyPath,
    "-out",
    tlsCertificatePath,
    "-days",
    "1",
    "-subj",
    `/CN=${gatewayHost}`,
    "-addext",
    `subjectAltName=${subjectAltName}`,
  ]);
  const gatewayCaCertificate = fs.readFileSync(tlsCertificatePath, "utf8");
  const warnings = [];
  const runtime = await createNodeRuntime({
    dataDir,
    localNodeId: `accept-${backend}-gateway`,
    config: { providers: [] },
    includeVscodeCli: false,
    externalDrivers: { enabled: false },
    workloadExecution: { enabled: false },
    logger: { warn: (...values) => warnings.push(values.map(String)) },
    llmProvider: {
      name: "acceptance-model",
      model: "acceptance-model",
      chat: async function* () {
        yield {
          type: "text-delta",
          content: `authenticated-${backend}-model-ok`,
          id: "acceptance-delta",
        };
      },
    },
  });
  const server = https.createServer(
    {
      key: fs.readFileSync(tlsKeyPath),
      cert: gatewayCaCertificate,
    },
    runtime.workerGateway?.handler,
  );
  let externalId;
  try {
    if (!runtime.workerGateway || !runtime.controlStore) {
      throw new Error("NodeRuntime did not expose its worker gateway and ControlStore");
    }
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "0.0.0.0", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("worker gateway did not bind");
    const gatewayUrl = `https://${gatewayHost}:${address.port}`;
    const profileActor = {
      id: `controller/external-profile-acceptance-${backend}`,
      kind: "controller",
    };
    const storedWorkload = await runtime.controlStore.create(
      profileActor,
      createAgentWorkloadManifest(`accept-${backend}-profile`, {
        profileId: "memeloop:general-assistant",
        promptReference: `authenticated ${backend} profile`,
        trust: "restricted",
        completionPolicy: "complete",
      }),
    );
    const storedRun = await runtime.controlStore.create(
      profileActor,
      createAgentRunManifest(`accept-${backend}-profile-run`, {
        workloadRef: {
          apiVersion: storedWorkload.apiVersion,
          kind: storedWorkload.kind,
          name: storedWorkload.metadata.name,
          namespace: storedWorkload.metadata.namespace,
          uid: storedWorkload.metadata.uid,
        },
        promptReference: `authenticated ${backend} profile`,
      }),
    );
    const token = randomBytes(32).toString("base64url");
    const enrollmentName = `accept-${backend}-enrollment-${suffix}`;
    const policyDigest = `sha256:${createHash("sha256")
      .update(JSON.stringify(storedWorkload.spec), "utf8")
      .digest("hex")}`;
    await runtime.controlStore.create(
      profileActor,
      createWorkerEnrollmentManifest(enrollmentName, {
        nodeRef: {
          apiVersion: "nodes.memeloop.io/v1alpha1",
          kind: "Node",
          name: `accept-${backend}-gateway`,
        },
        trustClass: "restricted",
        expectedGateway: gatewayUrl,
        gatewayKeyFingerprint: runtime.workerGateway.publicKeyFingerprint,
        audience: `worker-gateway://accept-${backend}-gateway`,
        allowedProtocol: WORKER_PROTOCOL_VERSION,
        run: { uid: storedRun.metadata.uid, attempt: 1, epoch: 1 },
        policyDigest,
        allowedMethods: ["assignment.pull", "capability.request"],
        allowedTargets: [storedRun.metadata.uid],
        bootstrapTokenHash: hashWorkerBootstrapToken(token),
        enrolledBy: profileActor.id,
        expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
      }),
    );
    externalId = (
      await driver.placeWorkload(storedWorkload, profileActor, {
        workerBootstrap: {
          apiVersion: WORKER_PROTOCOL_VERSION,
          gatewayUrl,
          gatewayPublicKey: runtime.workerGateway.publicKey,
          gatewayKeyFingerprint: runtime.workerGateway.publicKeyFingerprint,
          gatewayCaCertificate,
          enrollmentName,
          bootstrapToken: token,
        },
      })
    ).externalId;
    const status = await waitTerminal((id) => driver.getWorkloadStatus(id), externalId);
    if (
      status.phase !== "Succeeded" ||
      !status.runtimeResult?.summary?.includes(`authenticated-${backend}-model-ok`)
    ) {
      throw new Error(
        `unexpected authenticated profile result: ${JSON.stringify(status)}\n${warnings
          .map((warning) => JSON.stringify(warning))
          .join("\n")}`,
      );
    }
    const sessions = await runtime.controlStore.list({
      apiVersion: "security.memeloop.io/v1alpha1",
      kind: "WorkerSession",
    });
    if (
      sessions.items.length !== 1 ||
      sessions.items[0].status?.phase !== "Active" ||
      sessions.items[0].status?.lastSequence !== 2
    ) {
      throw new Error(`unexpected worker sessions: ${JSON.stringify(sessions.items)}`);
    }
    return {
      result: status.runtimeResult,
      session: {
        phase: sessions.items[0].status.phase,
        lastSequence: sessions.items[0].status.lastSequence,
      },
    };
  } finally {
    if (externalId) await driver.stopWorkload(externalId, actor).catch(() => undefined);
    await new Promise((resolve) => server.close(() => resolve()));
    await runtime.stop();
    await runtime.controlStore?.close();
    runtime.storage?.close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

let workloadId;
let toolId;
let createdImagePullSecret = false;
try {
  if (backend === "k8s" && k8sDockerConfigFile && k8sImagePullSecret) {
    const { KubernetesApiClient } = await import("../packages/memeloop-k8s/dist/index.js");
    const dockerConfigStat = fs.statSync(k8sDockerConfigFile);
    if ((dockerConfigStat.mode & 0o077) !== 0) {
      throw new Error("MEMELOOP_K8S_DOCKER_CONFIG_FILE must not be accessible by group or others");
    }
    const rawDockerConfig = fs.readFileSync(k8sDockerConfigFile);
    if (rawDockerConfig.byteLength < 2 || rawDockerConfig.byteLength > 64 * 1024) {
      throw new Error("MEMELOOP_K8S_DOCKER_CONFIG_FILE must be between 2 bytes and 64 KiB");
    }
    const parsedDockerConfig = JSON.parse(rawDockerConfig.toString("utf8"));
    if (
      !parsedDockerConfig ||
      typeof parsedDockerConfig !== "object" ||
      Array.isArray(parsedDockerConfig) ||
      !parsedDockerConfig.auths ||
      typeof parsedDockerConfig.auths !== "object" ||
      !Object.values(parsedDockerConfig.auths).some(
        (credential) =>
          credential &&
          typeof credential === "object" &&
          !Array.isArray(credential) &&
          ["auth", "identitytoken", "registrytoken"].some(
            (key) => typeof credential[key] === "string" && credential[key].length > 0,
          ),
      )
    ) {
      throw new Error(
        "MEMELOOP_K8S_DOCKER_CONFIG_FILE must contain a concrete Docker registry credential",
      );
    }
    const apiClient = new KubernetesApiClient({
      baseUrl: process.env.MEMELOOP_K8S_BASE_URL,
      ...(process.env.MEMELOOP_K8S_TOKEN_FILE
        ? { bearerTokenFile: process.env.MEMELOOP_K8S_TOKEN_FILE }
        : {}),
      ...(process.env.MEMELOOP_K8S_CA_FILE
        ? { caCertificateFile: process.env.MEMELOOP_K8S_CA_FILE }
        : {}),
    });
    await apiClient.request("POST", "/api/v1/namespaces/default/secrets", {
      body: {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: k8sImagePullSecret, namespace: "default" },
        type: "kubernetes.io/dockerconfigjson",
        data: {
          ".dockerconfigjson": rawDockerConfig.toString("base64"),
        },
      },
    });
    createdImagePullSecret = true;
  }

  const health = await driver.getHealth();
  if (!health.healthy) throw new Error(`driver is unhealthy: ${health.detail ?? "unknown"}`);
  workloadId = (await driver.placeWorkload(workload, actor, { scriptSource: source })).externalId;
  const workloadStatus = await waitTerminal(
    (externalId) => driver.getWorkloadStatus(externalId),
    workloadId,
  );
  if (
    workloadStatus.phase !== "Succeeded" ||
    workloadStatus.runtimeResult?.summary !== `real-${backend}-ok`
  ) {
    throw new Error(`unexpected workload result: ${JSON.stringify(workloadStatus)}`);
  }
  toolId = (await driver.executeToolOperation(operation, actor)).externalId;
  const toolStatus = await waitTerminal(
    (externalId) => driver.getToolOperationStatus(externalId),
    toolId,
  );
  if (
    toolStatus.phase !== "Succeeded" ||
    toolStatus.runtimeResult?.result?.value?.accepted !== true
  ) {
    throw new Error(`unexpected tool result: ${JSON.stringify(toolStatus)}`);
  }
  const authenticatedProfile = await acceptAuthenticatedProfile();
  process.stdout.write(
    `${JSON.stringify({
      backend,
      health: true,
      workload: workloadStatus.runtimeResult,
      tool: toolStatus.runtimeResult,
      ...(authenticatedProfile ? { authenticatedProfile } : {}),
    })}\n`,
  );
} finally {
  if (workloadId) await driver.stopWorkload(workloadId, actor).catch(() => undefined);
  if (toolId) await driver.cancelToolOperation(toolId, actor).catch(() => undefined);
  if (backend === "k8s" && createdImagePullSecret && k8sImagePullSecret) {
    const { KubernetesApiClient } = await import("../packages/memeloop-k8s/dist/index.js");
    const apiClient = new KubernetesApiClient({
      baseUrl: process.env.MEMELOOP_K8S_BASE_URL,
      ...(process.env.MEMELOOP_K8S_TOKEN_FILE
        ? { bearerTokenFile: process.env.MEMELOOP_K8S_TOKEN_FILE }
        : {}),
      ...(process.env.MEMELOOP_K8S_CA_FILE
        ? { caCertificateFile: process.env.MEMELOOP_K8S_CA_FILE }
        : {}),
    });
    await apiClient
      .request(
        "DELETE",
        `/api/v1/namespaces/default/secrets/${encodeURIComponent(k8sImagePullSecret)}`,
      )
      .catch(() => undefined);
  }
}
