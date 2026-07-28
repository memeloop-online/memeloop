#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const image = process.env.MEMELOOP_ACCEPTANCE_IMAGE ?? "memeloop/worker-runtime:0.0.1-auth";
const requireCanonical = process.env.MEMELOOP_REQUIRE_CANONICAL_IMAGE === "true";
const dockerConfigFile = process.env.MEMELOOP_DOCKER_CONFIG_FILE;
const k3sImage =
  "rancher/k3s@sha256:044ed1528f02aeb9c83cc640c1785fddf19d6fbcfc77976c659979d58716fb09";
const pauseImage =
  "rancher/mirrored-pause:3.6@sha256:74c4244427b7312c5b901fe0f67cbc53683d06f4f24c6faee65d4182bf0fa893";
const canonicalImage = /^ghcr\.io\/linonetwo\/memeloop-worker-runtime@sha256:[a-f0-9]{64}$/;
const k3sName = `memeloop-k3s-${process.pid}`;
const evidence = {};
let initializedSwarm = false;
let createdSwarmGatewayBridge = false;
let startedK3s = false;
let cleanedUp = false;
let activeAcceptance;

if (requireCanonical && !canonicalImage.test(image)) {
  throw new Error(
    "MEMELOOP_ACCEPTANCE_IMAGE must be the canonical GHCR coordinate pinned by sha256 digest",
  );
}
if (requireCanonical && !dockerConfigFile) {
  throw new Error("MEMELOOP_DOCKER_CONFIG_FILE is required for private canonical-image acceptance");
}
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "memeloop-external-acceptance-"));

function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  activeAcceptance?.kill("SIGTERM");
  if (startedK3s) {
    spawnSync("docker", ["rm", "--force", k3sName], { stdio: "ignore" });
  }
  if (initializedSwarm) {
    spawnSync("docker", ["swarm", "leave", "--force"], { stdio: "ignore" });
  }
  if (createdSwarmGatewayBridge) {
    spawnSync("docker", ["network", "rm", "docker_gwbridge"], { stdio: "ignore" });
  }
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, () => {
    cleanup();
    process.exit(exitCode);
  });
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    stdio: options.stdio ?? "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(" ")} failed (${String(result.status)}):\n` +
        `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-16_384),
    );
  }
  return String(result.stdout ?? "").trim();
}

function ensurePinnedImage(reference) {
  const local = spawnSync("docker", ["image", "inspect", reference], {
    cwd: root,
    encoding: "utf8",
    stdio: "ignore",
  });
  if (local.status !== 0) {
    run("docker", ["pull", reference]);
  }
  // Re-inspect the exact digest reference: a mutable tag or unrelated local
  // image must never satisfy cluster bootstrap.
  run("docker", ["image", "inspect", reference, "--format", "{{.Id}}"]);
}

async function runAcceptance(backend, environment) {
  const child = spawn(process.execPath, ["scripts/accept-external-driver.mjs", backend], {
    cwd: root,
    env: {
      ...process.env,
      MEMELOOP_ACCEPTANCE_IMAGE: image,
      MEMELOOP_REQUIRE_CANONICAL_IMAGE: String(requireCanonical),
      ...environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeAcceptance = child;
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
  if (activeAcceptance === child) activeAcceptance = undefined;
  if (code !== 0) {
    throw new Error(`${backend} acceptance failed (${String(code)}):\n${output.slice(-16_384)}`);
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
    .find((value) => value?.backend === backend);
  if (!record) {
    throw new Error(`${backend} acceptance did not emit its evidence record`);
  }
  return record;
}

function networkGateway(name) {
  const value = run("docker", [
    "network",
    "inspect",
    name,
    "--format",
    "{{(index .IPAM.Config 0).Gateway}}",
  ]);
  if (!value) throw new Error(`Docker network ${name} has no gateway`);
  return value;
}

function networkSubnet(name) {
  const value = run("docker", [
    "network",
    "inspect",
    name,
    "--format",
    "{{(index .IPAM.Config 0).Subnet}}",
  ]);
  if (!value) throw new Error(`Docker network ${name} has no subnet`);
  return value;
}

function createRegistryAuthFile() {
  if (!dockerConfigFile) return undefined;
  const stat = fs.statSync(dockerConfigFile);
  if (!stat.isFile() || stat.size < 2 || stat.size > 64 * 1024) {
    throw new Error("MEMELOOP_DOCKER_CONFIG_FILE must be a regular file no larger than 64 KiB");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("MEMELOOP_DOCKER_CONFIG_FILE must not be accessible by group or others");
  }
  const config = JSON.parse(fs.readFileSync(dockerConfigFile, "utf8"));
  const credential = config?.auths?.["ghcr.io"];
  if (
    !credential ||
    typeof credential !== "object" ||
    Array.isArray(credential) ||
    !["auth", "identitytoken", "registrytoken"].some(
      (key) => typeof credential[key] === "string" && credential[key].length > 0,
    )
  ) {
    throw new Error("Docker config does not contain a concrete ghcr.io credential");
  }
  const auth = {
    ...credential,
    serveraddress: "ghcr.io",
  };
  const authFile = path.join(temporaryDirectory, "swarm-registry-auth.json");
  fs.writeFileSync(authFile, JSON.stringify(auth), { mode: 0o600 });
  return authFile;
}

function parseKubeconfig(kubeconfigPath) {
  const source = fs.readFileSync(kubeconfigPath, "utf8");
  const encodedCertificate = source.match(/^\s*certificate-authority-data:\s*(\S+)\s*$/m)?.[1];
  if (!encodedCertificate) {
    throw new Error("K3s kubeconfig is missing certificate-authority-data");
  }
  const certificateFile = path.join(temporaryDirectory, "k3s-ca.pem");
  fs.writeFileSync(certificateFile, Buffer.from(encodedCertificate, "base64"), { mode: 0o600 });
  return certificateFile;
}

async function createK3sAcceptanceToken() {
  const deadline = Date.now() + 90_000;
  let healthy = false;
  while (Date.now() < deadline) {
    const result = spawnSync(
      "docker",
      ["exec", k3sName, "kubectl", "--kubeconfig=/output/kubeconfig.yaml", "get", "--raw=/healthz"],
      {
        encoding: "utf8",
        stdio: "pipe",
      },
    );
    if (result.status === 0 && result.stdout.trim() === "ok") {
      healthy = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!healthy) {
    throw new Error("K3s API did not become healthy inside the server container within 90 seconds");
  }

  run("docker", [
    "exec",
    k3sName,
    "kubectl",
    "--kubeconfig=/output/kubeconfig.yaml",
    "create",
    "serviceaccount",
    "memeloop-acceptance",
    "--namespace=default",
  ]);
  run("docker", [
    "exec",
    k3sName,
    "kubectl",
    "--kubeconfig=/output/kubeconfig.yaml",
    "create",
    "clusterrolebinding",
    "memeloop-acceptance",
    "--clusterrole=cluster-admin",
    "--serviceaccount=default:memeloop-acceptance",
  ]);
  const token = run("docker", [
    "exec",
    k3sName,
    "kubectl",
    "--kubeconfig=/output/kubeconfig.yaml",
    "create",
    "token",
    "memeloop-acceptance",
    "--namespace=default",
    "--duration=2h",
  ]);
  const tokenFile = path.join(temporaryDirectory, "k3s-token");
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  return { token, tokenFile };
}

async function waitForK3s(baseUrl, token, certificateFile) {
  const deadline = Date.now() + 90_000;
  const ca = fs.readFileSync(certificateFile);
  while (Date.now() < deadline) {
    const healthy = await new Promise((resolve) => {
      const request = https.get(
        `${baseUrl}/healthz`,
        {
          ca,
          headers: { Authorization: `Bearer ${token}` },
          timeout: 2_000,
        },
        (response) => {
          response.resume();
          resolve(response.statusCode === 200);
        },
      );
      request.once("timeout", () => request.destroy());
      request.once("error", () => resolve(false));
    });
    if (healthy) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("K3s API did not become healthy within 90 seconds");
}

async function acceptSwarm(registryAuthFile) {
  const swarmState = run("docker", ["info", "--format", "{{.Swarm.LocalNodeState}}"]);
  if (swarmState !== "inactive") {
    throw new Error(`Refusing to alter an existing Docker Swarm (current state: ${swarmState})`);
  }
  const gatewayBridge = spawnSync("docker", ["network", "inspect", "docker_gwbridge"], {
    encoding: "utf8",
    stdio: "ignore",
  });
  if (gatewayBridge.status !== 0) {
    run("docker", [
      "network",
      "create",
      "--driver",
      "bridge",
      "--opt",
      "com.docker.network.bridge.enable_icc=false",
      "--opt",
      "com.docker.network.bridge.enable_ip_masquerade=true",
      "docker_gwbridge",
    ]);
    createdSwarmGatewayBridge = true;
  }
  run("docker", ["swarm", "init", "--advertise-addr", "127.0.0.1"]);
  initializedSwarm = true;
  const result = await runAcceptance("swarm", {
    MEMELOOP_ACCEPTANCE_GATEWAY_HOST: networkGateway("docker_gwbridge"),
    ...(registryAuthFile ? { MEMELOOP_SWARM_REGISTRY_AUTH_FILE: registryAuthFile } : {}),
  });
  evidence.swarm = result;
}

async function acceptK3s() {
  const outputDirectory = path.join(temporaryDirectory, "k3s");
  fs.mkdirSync(outputDirectory, { mode: 0o700 });
  const bridgeGateway = networkGateway("bridge");
  const bridgeSubnet = networkSubnet("bridge");
  const noProxy = [
    "localhost",
    "127.0.0.1",
    "::1",
    bridgeGateway,
    bridgeSubnet,
    "10.42.0.0/16",
    "10.43.0.0/16",
    ".svc",
    ".cluster.local",
  ].join(",");
  ensurePinnedImage(k3sImage);
  ensurePinnedImage(pauseImage);
  run("docker", [
    "run",
    "--detach",
    "--name",
    k3sName,
    "--privileged",
    "--publish",
    "127.0.0.1::6443",
    "--volume",
    `${outputDirectory}:/output`,
    "--env",
    `NO_PROXY=${noProxy}`,
    "--env",
    `no_proxy=${noProxy}`,
    k3sImage,
    "server",
    "--disable=traefik",
    "--disable=servicelb",
    "--pause-image",
    pauseImage,
    "--tls-san=127.0.0.1",
    "--write-kubeconfig=/output/kubeconfig.yaml",
    // The parent temporary directory is 0700. Use 0644 here so the
    // unprivileged host runner can read the root-created bind-mount file.
    "--write-kubeconfig-mode=644",
  ]);
  startedK3s = true;
  const kubeconfigPath = path.join(outputDirectory, "kubeconfig.yaml");
  const deadline = Date.now() + 60_000;
  while (!fs.existsSync(kubeconfigPath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!fs.existsSync(kubeconfigPath)) {
    const logs = spawnSync("docker", ["logs", "--tail", "200", k3sName], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    });
    throw new Error(
      `K3s did not write its kubeconfig within 60 seconds:\n${`${logs.stdout ?? ""}${logs.stderr ?? ""}`.slice(
        -16_384,
      )}`,
    );
  }
  const portOutput = run("docker", ["port", k3sName, "6443/tcp"]);
  const port = portOutput.match(/:(\d+)\s*$/)?.[1];
  if (!port) throw new Error(`Could not parse K3s API port from ${portOutput}`);
  const baseUrl = `https://127.0.0.1:${port}`;
  const certificateFile = parseKubeconfig(kubeconfigPath);
  const { token, tokenFile } = await createK3sAcceptanceToken();
  await waitForK3s(baseUrl, token, certificateFile);

  const imageArchive = path.join(temporaryDirectory, "k3s-images.tar");
  run("docker", [
    "image",
    "save",
    "--output",
    imageArchive,
    pauseImage,
    ...(!dockerConfigFile ? [image] : []),
  ]);
  run("docker", ["cp", imageArchive, `${k3sName}:/tmp/k3s-images.tar`]);
  run("docker", ["exec", k3sName, "ctr", "images", "import", "/tmp/k3s-images.tar"]);

  const result = await runAcceptance("k8s", {
    MEMELOOP_ACCEPTANCE_GATEWAY_HOST: bridgeGateway,
    MEMELOOP_K8S_BASE_URL: baseUrl,
    MEMELOOP_K8S_TOKEN_FILE: tokenFile,
    MEMELOOP_K8S_CA_FILE: certificateFile,
    ...(dockerConfigFile ? { MEMELOOP_K8S_DOCKER_CONFIG_FILE: dockerConfigFile } : {}),
  });
  evidence.k8s = result;
}

try {
  const registryAuthFile = createRegistryAuthFile();
  run("docker", ["image", "inspect", image, "--format", "{{.Id}}"]);
  await acceptSwarm(registryAuthFile);
  run("docker", ["swarm", "leave", "--force"]);
  initializedSwarm = false;
  await acceptK3s();
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        image,
        immutableCanonicalImage: canonicalImage.test(image),
        k3sImage,
        pauseImage,
        evidence,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  const k3sLogs = startedK3s
    ? spawnSync("docker", ["logs", "--tail", "200", k3sName], {
        cwd: root,
        encoding: "utf8",
        stdio: "pipe",
      })
    : undefined;
  const diagnostics = k3sLogs
    ? `${k3sLogs.stdout ?? ""}${k3sLogs.stderr ?? ""}`.slice(-16_384)
    : "";
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}${
      diagnostics ? `\nK3s logs:\n${diagnostics}` : ""
    }`,
    { cause: error },
  );
} finally {
  cleanup();
}
