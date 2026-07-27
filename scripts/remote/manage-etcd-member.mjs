import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const image =
  "quay.io/coreos/etcd:v3.6.11@sha256:6ae247c7666ceec554c51ba1f9bc8dd2212f975370dbd65710c9ca0e36ae1fff";
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/;
const maximumOutputBytes = 256 * 1024;
const configuration = globalThis.__MEMELOOP_REMOTE_CONFIGURATION__;

function validateConfiguration(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "action",
          "runId",
          "hostName",
          "address",
          "clientPort",
          "peerPort",
          "cluster",
          "certificateAuthority",
          "certificate",
          "privateKey",
        ].includes(key),
    )
  ) {
    throw new Error("remote etcd configuration contains unsupported fields");
  }
  if (!["start", "stop", "restart", "cleanup", "status"].includes(value.action)) {
    throw new Error("unsupported remote etcd action");
  }
  for (const field of ["runId", "hostName"]) {
    if (typeof value[field] !== "string" || !identifierPattern.test(value[field])) {
      throw new Error(`${field} must be a bounded identifier`);
    }
  }
  if (typeof value.address !== "string" || value.address.length < 1 || value.address.length > 253) {
    throw new Error("address is invalid");
  }
  for (const field of ["clientPort", "peerPort"]) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 1024 || value[field] > 65_535) {
      throw new Error(`${field} must be between 1024 and 65535`);
    }
  }
  if (value.clientPort === value.peerPort) {
    throw new Error("client and peer ports must differ");
  }
  if (typeof value.cluster !== "string" || value.cluster.length > 16_384) {
    throw new Error("initial cluster is invalid");
  }
  if (value.action === "start") {
    for (const field of ["certificateAuthority", "certificate", "privateKey"]) {
      if (
        typeof value[field] !== "string" ||
        value[field].length < 32 ||
        value[field].length > 32 * 1024
      ) {
        throw new Error(`${field} is invalid`);
      }
    }
  }
  return value;
}

async function command(commandName, arguments_, { allowFailure = false } = {}) {
  const child = spawn(commandName, arguments_, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk) => {
    output += chunk.toString("utf8");
    if (Buffer.byteLength(output, "utf8") > maximumOutputBytes) child.kill("SIGKILL");
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (Buffer.byteLength(output, "utf8") > maximumOutputBytes) {
    throw new Error(`${commandName} exceeded the output bound`);
  }
  if (code !== 0 && !allowFailure) {
    throw new Error(
      `${commandName} failed with exit code ${String(code)}\n${output.slice(-16_384)}`,
    );
  }
  return { code, output: output.trim() };
}

const value = validateConfiguration(configuration);
if (process.platform !== "linux") throw new Error("remote etcd requires Linux");
if (Number.parseInt(process.versions.node.split(".")[0], 10) < 24) {
  throw new Error("remote etcd requires Node 24 or newer");
}
const container = `memeloop-etcd-${value.runId}-${value.hostName}`;
const directory = path.join("/tmp", container);

if (value.action === "start") {
  const existing = await command("docker", ["inspect", container], {
    allowFailure: true,
  });
  if (existing.code === 0) throw new Error(`container ${container} already exists`);
  await mkdir(directory, { mode: 0o700 });
  await Promise.all([
    writeFile(path.join(directory, "ca.pem"), value.certificateAuthority, {
      mode: 0o600,
      flag: "wx",
    }),
    writeFile(path.join(directory, "server.pem"), value.certificate, {
      mode: 0o600,
      flag: "wx",
    }),
    writeFile(path.join(directory, "server-key.pem"), value.privateKey, {
      mode: 0o600,
      flag: "wx",
    }),
  ]);
  try {
    await command("docker", ["pull", image]);
    await command("docker", [
      "run",
      "--detach",
      "--name",
      container,
      "--network",
      "host",
      "--restart",
      "no",
      "--volume",
      `${directory}:/certs:ro`,
      "--env",
      "ALL_PROXY=",
      "--env",
      "HTTP_PROXY=",
      "--env",
      "HTTPS_PROXY=",
      "--env",
      "NO_PROXY=*",
      image,
      "/usr/local/bin/etcd",
      "--name",
      value.hostName,
      "--data-dir",
      "/etcd-data",
      "--listen-client-urls",
      `https://0.0.0.0:${value.clientPort}`,
      "--advertise-client-urls",
      `https://${value.address}:${value.clientPort}`,
      "--listen-peer-urls",
      `https://0.0.0.0:${value.peerPort}`,
      "--initial-advertise-peer-urls",
      `https://${value.address}:${value.peerPort}`,
      "--initial-cluster",
      value.cluster,
      "--initial-cluster-token",
      `memeloop-${value.runId}`,
      "--initial-cluster-state",
      "new",
      "--client-cert-auth",
      "--trusted-ca-file",
      "/certs/ca.pem",
      "--cert-file",
      "/certs/server.pem",
      "--key-file",
      "/certs/server-key.pem",
      "--peer-client-cert-auth",
      "--peer-trusted-ca-file",
      "/certs/ca.pem",
      "--peer-cert-file",
      "/certs/server.pem",
      "--peer-key-file",
      "/certs/server-key.pem",
      "--log-level",
      "warn",
    ]);
  } catch (error) {
    await command("docker", ["rm", "--force", container], {
      allowFailure: true,
    });
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

if (value.action === "stop") {
  await command("docker", ["stop", "--time", "2", container]);
}
if (value.action === "restart") {
  await command("docker", ["start", container]);
}
if (value.action === "cleanup") {
  await command("docker", ["rm", "--force", container], {
    allowFailure: true,
  });
  await rm(directory, { recursive: true, force: true });
}

let state = "removed";
if (value.action !== "cleanup") {
  const inspection = await command("docker", [
    "inspect",
    "--format",
    "{{.State.Status}}",
    container,
  ]);
  state = inspection.output;
}
const [machineId, bootId] = await Promise.all([
  readFile("/etc/machine-id", "utf8").then((result) => result.trim()),
  readFile("/proc/sys/kernel/random/boot_id", "utf8").then((result) => result.trim()),
]);
assert.ok(machineId.length >= 8 && bootId.length >= 8);
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    action: value.action,
    state,
    machineId,
    bootId,
  })}\n`,
);
