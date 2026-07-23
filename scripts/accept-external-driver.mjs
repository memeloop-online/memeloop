import { createHash, randomUUID } from "node:crypto";

const backend = process.argv[2];
if (backend !== "swarm" && backend !== "k8s") {
  throw new Error("usage: node scripts/accept-external-driver.mjs <swarm|k8s>");
}

const image = process.env.MEMELOOP_ACCEPTANCE_IMAGE ?? "memeloop/worker-runtime:0.0.1";
const timeoutMs = Number.parseInt(process.env.MEMELOOP_ACCEPTANCE_TIMEOUT_MS ?? "60000", 10);
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
  throw new Error("MEMELOOP_ACCEPTANCE_TIMEOUT_MS must be at least 1000");
}

const driver =
  backend === "swarm"
    ? new (await import("../packages/memeloop-swarm/dist/index.js")).SwarmOrchestrationDriver({
        defaultWorkloadImage: image,
        defaultToolImage: image,
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
      });

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
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
  apiVersion: "tools.memeloop.io/v1alpha1",
  kind: "ToolOperation",
  metadata: metadata(`accept-${backend}-tool`),
  spec: {
    runRef: {
      apiVersion: "run.memeloop.io/v1alpha1",
      kind: "AgentRun",
      name: `accept-${backend}-run`,
      uid: `accept-${backend}-run-${suffix}`,
    },
    attempt: 1,
    toolRef: {
      apiVersion: "tools.memeloop.io/v1alpha1",
      kind: "ToolClass",
      name: "memeloop.runtime.echo",
    },
    schemaDigest: `sha256:${"0".repeat(64)}`,
    arguments: { accepted: true },
    idempotencyKey: `accept-${backend}-${suffix}`,
    caller: { agentId: "external-driver-acceptance", workerKey: `worker-${suffix}` },
    target: { kind: "host", name: backend },
    dataClassification: "public",
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

let workloadId;
let toolId;
try {
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
  process.stdout.write(
    `${JSON.stringify({
      backend,
      health: true,
      workload: workloadStatus.runtimeResult,
      tool: toolStatus.runtimeResult,
    })}\n`,
  );
} finally {
  if (workloadId) await driver.stopWorkload(workloadId, actor).catch(() => undefined);
  if (toolId) await driver.cancelToolOperation(toolId, actor).catch(() => undefined);
}
