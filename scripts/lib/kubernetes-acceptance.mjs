import { spawn } from "node:child_process";

const maximumOutputBytes = 2 * 1024 * 1024;

export function createKubectl(options = {}) {
  const command = options.command ?? process.env.MEMELOOP_KUBECTL ?? "kubectl";
  const prefixArguments =
    options.prefixArguments ?? parsePrefixArguments(process.env.MEMELOOP_KUBECTL_PREFIX_JSON);
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;

  return async function kubectl(arguments_, commandOptions = {}) {
    const child = spawn(command, [...prefixArguments, ...arguments_], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (commandOptions.input === undefined) child.stdin.end();
    else child.stdin.end(commandOptions.input);
    let stdout = "";
    let stderr = "";
    let exceededOutputBound = false;
    const append = (stream) => (chunk) => {
      if (stream === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
      if (
        Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") >
        maximumOutputBytes
      ) {
        exceededOutputBound = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", append("stdout"));
    child.stderr.on("data", append("stderr"));
    const timeout = setTimeout(() => child.kill("SIGKILL"), commandOptions.timeoutMs ?? timeoutMs);
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    clearTimeout(timeout);
    if (exceededOutputBound) throw new Error("kubectl exceeded the output bound");
    if (code !== 0 && !commandOptions.allowFailure) {
      throw new Error(
        `kubectl ${arguments_.join(" ")} failed with exit code ${String(code)}\n` +
          stderr.slice(-16_384),
      );
    }
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  };
}

function parsePrefixArguments(value) {
  if (value === undefined) return [];
  const parsed = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length > 16 ||
    parsed.some(
      (item) =>
        typeof item !== "string" || item.length < 1 || item.length > 256 || item.includes("\0"),
    )
  ) {
    throw new Error("MEMELOOP_KUBECTL_PREFIX_JSON must be a bounded JSON string array");
  }
  return parsed;
}

export function workerJob({
  name,
  namespace,
  nodeName,
  completions,
  image,
  runId,
  imagePullSecret,
}) {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name,
      namespace,
      labels: {
        "app.kubernetes.io/name": "memeloop-worker-acceptance",
        "memeloop.io/acceptance-run": runId,
      },
    },
    spec: {
      backoffLimit: 0,
      completions,
      parallelism: Math.min(completions, 8),
      completionMode: "Indexed",
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: {
          labels: {
            "app.kubernetes.io/name": "memeloop-worker-acceptance",
            "memeloop.io/acceptance-run": runId,
          },
        },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          ...(imagePullSecret ? { imagePullSecrets: [{ name: imagePullSecret }] } : {}),
          nodeSelector: { "kubernetes.io/hostname": nodeName },
          restartPolicy: "Never",
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "worker",
              image,
              imagePullPolicy: "IfNotPresent",
              env: [
                {
                  name: "MEMELOOP_TOOL_OPERATION",
                  value: JSON.stringify({
                    toolRef: { name: "memeloop.runtime.health" },
                    arguments: {},
                  }),
                },
              ],
              resources: {
                requests: { cpu: "10m", memory: "16Mi" },
                limits: { cpu: "250m", memory: "64Mi" },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
                readOnlyRootFilesystem: true,
              },
            },
          ],
        },
      },
    },
  };
}

export function validateCompletedWorkerPods(podList, expected) {
  if ((podList?.kind !== "PodList" && podList?.kind !== "List") || !Array.isArray(podList.items)) {
    throw new Error("kubectl did not return a pod list");
  }
  if (podList.items.length !== expected.workers) {
    throw new Error(
      `Kubernetes ran ${String(podList.items.length)} worker pods, expected ${expected.workers}`,
    );
  }
  for (const pod of podList.items) {
    if (pod.spec?.nodeName !== expected.nodeName) {
      throw new Error(`${pod.metadata?.name ?? "unknown pod"} ran on an unexpected node`);
    }
    if (pod.status?.phase !== "Succeeded") {
      throw new Error(`${pod.metadata?.name ?? "unknown pod"} did not succeed`);
    }
    const status = pod.status?.containerStatuses?.[0];
    if (status?.state?.terminated?.exitCode !== 0) {
      throw new Error(`${pod.metadata?.name ?? "unknown pod"} worker exited unsuccessfully`);
    }
  }
  return podList.items;
}
