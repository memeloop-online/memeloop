import { createHash } from "node:crypto";
import { isIP } from "node:net";

export const canonicalWorkerImagePattern =
  /^ghcr\.io\/linonetwo\/memeloop-worker-runtime@sha256:[a-f0-9]{64}$/;

const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;
const sshTargetPattern =
  /^(?:[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}@)?[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/;
const networkHostPattern = /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/;

function assertPlainRecord(value, label) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be a plain object`);
  }
}

function rejectUnknownKeys(record, allowed, label) {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown fields: ${unknown.join(", ")}`);
  }
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

export function validateMultiHostInventory(input) {
  assertPlainRecord(input, "inventory");
  rejectUnknownKeys(input, new Set(["version", "hosts"]), "inventory");
  if (input.version !== 1) {
    throw new Error("inventory.version must be 1");
  }
  if (!Array.isArray(input.hosts) || input.hosts.length < 3) {
    throw new Error("inventory.hosts must contain at least three physical hosts");
  }
  if (input.hosts.length > 64) {
    throw new Error("inventory.hosts cannot contain more than 64 hosts");
  }

  const names = new Set();
  const targets = new Set();
  const hosts = input.hosts.map((host, index) => {
    const label = `inventory.hosts[${index}]`;
    assertPlainRecord(host, label);
    rejectUnknownKeys(host, new Set(["name", "target", "port", "faultDomain", "address"]), label);
    if (typeof host.name !== "string" || !identifierPattern.test(host.name)) {
      throw new Error(`${label}.name must be a bounded identifier`);
    }
    if (typeof host.faultDomain !== "string" || !identifierPattern.test(host.faultDomain)) {
      throw new Error(`${label}.faultDomain must be a bounded identifier`);
    }
    if (typeof host.target !== "string" || !sshTargetPattern.test(host.target)) {
      throw new Error(`${label}.target must be a user@host SSH target without shell syntax`);
    }
    if (
      host.address !== undefined &&
      (typeof host.address !== "string" ||
        (!isIP(host.address) && !networkHostPattern.test(host.address)))
    ) {
      throw new Error(`${label}.address must be an IP address or bounded DNS name`);
    }
    const port = host.port === undefined ? 22 : positiveInteger(host.port, `${label}.port`, 65_535);
    if (names.has(host.name)) throw new Error(`duplicate host name: ${host.name}`);
    const endpointKey = `${host.target}:${port}`;
    if (targets.has(endpointKey)) throw new Error(`duplicate SSH endpoint: ${endpointKey}`);
    names.add(host.name);
    targets.add(endpointKey);
    return {
      name: host.name,
      target: host.target,
      port,
      faultDomain: host.faultDomain,
      ...(host.address === undefined ? {} : { address: host.address }),
    };
  });

  if (new Set(hosts.map((host) => host.faultDomain)).size < 3) {
    throw new Error("inventory must span at least three distinct fault domains");
  }
  return { version: 1, hosts };
}

export function validateKubernetesInventory(input) {
  assertPlainRecord(input, "inventory");
  rejectUnknownKeys(
    input,
    new Set(["version", "transport", "namespacePrefix", "nodes"]),
    "inventory",
  );
  if (input.version !== 2) {
    throw new Error("Kubernetes inventory.version must be 2");
  }
  if (input.transport !== "kubernetes") {
    throw new Error('Kubernetes inventory.transport must be "kubernetes"');
  }
  if (
    input.namespacePrefix !== undefined &&
    (typeof input.namespacePrefix !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(input.namespacePrefix))
  ) {
    throw new Error("inventory.namespacePrefix must be a bounded DNS label");
  }
  if (!Array.isArray(input.nodes) || input.nodes.length < 3) {
    throw new Error("inventory.nodes must contain at least three physical nodes");
  }
  if (input.nodes.length > 64) {
    throw new Error("inventory.nodes cannot contain more than 64 nodes");
  }

  const names = new Set();
  const nodes = input.nodes.map((node, index) => {
    const label = `inventory.nodes[${index}]`;
    assertPlainRecord(node, label);
    rejectUnknownKeys(node, new Set(["name", "faultDomain"]), label);
    if (
      typeof node.name !== "string" ||
      !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(node.name)
    ) {
      throw new Error(`${label}.name must be a bounded Kubernetes node name`);
    }
    if (typeof node.faultDomain !== "string" || !identifierPattern.test(node.faultDomain)) {
      throw new Error(`${label}.faultDomain must be a bounded identifier`);
    }
    if (names.has(node.name)) throw new Error(`duplicate Kubernetes node name: ${node.name}`);
    names.add(node.name);
    return { name: node.name, faultDomain: node.faultDomain };
  });
  if (new Set(nodes.map((node) => node.faultDomain)).size < 3) {
    throw new Error("inventory must span at least three distinct fault domains");
  }
  return {
    version: 2,
    transport: "kubernetes",
    namespacePrefix: input.namespacePrefix ?? "memeloop-acceptance",
    nodes,
  };
}

export function validateKubernetesEtcdInventory(input) {
  const inventory = validateKubernetesInventory(input);
  if (inventory.nodes.length !== 3) {
    throw new Error("Kubernetes etcd acceptance requires exactly three nodes");
  }
  return inventory;
}

export function validateMultiHostEtcdInventory(input) {
  const inventory = validateMultiHostInventory(input);
  if (inventory.hosts.length !== 3) {
    throw new Error("multi-host etcd acceptance requires exactly three hosts");
  }
  const addresses = new Set();
  const hosts = inventory.hosts.map((host, index) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(host.name)) {
      throw new Error(
        `inventory.hosts[${index}].name must use only letters, digits, and hyphens for etcd`,
      );
    }
    if (
      typeof host.address !== "string" ||
      (!isIP(host.address) && !networkHostPattern.test(host.address))
    ) {
      throw new Error(
        `inventory.hosts[${index}].address must be an IP address or bounded DNS name reachable by every host and the controller`,
      );
    }
    if (addresses.has(host.address)) {
      throw new Error(`duplicate etcd advertise address: ${host.address}`);
    }
    addresses.add(host.address);
    return host;
  });
  return { version: 1, hosts };
}

export function validateCanonicalWorkerImage(image) {
  if (typeof image !== "string" || !canonicalWorkerImagePattern.test(image)) {
    throw new Error(
      "image must be ghcr.io/linonetwo/memeloop-worker-runtime pinned by a sha256 manifest digest",
    );
  }
  return image;
}

export function distributeWorkers(total, hosts) {
  positiveInteger(total, "fleet size", 100_000);
  if (!Array.isArray(hosts) || hosts.length < 1) {
    throw new Error("hosts must not be empty");
  }
  if (total < hosts.length) {
    throw new Error("fleet size must assign at least one worker to every host");
  }
  const base = Math.floor(total / hosts.length);
  const remainder = total % hosts.length;
  return hosts.map((host, index) => ({
    host,
    workers: base + (index < remainder ? 1 : 0),
  }));
}

export function hashHostIdentity(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > 256) {
    throw new Error("host identity must contain between 8 and 256 characters");
  }
  return createHash("sha256").update(value).digest("hex");
}

export function validateRemoteEvidence(input, expected) {
  assertPlainRecord(input, "remote evidence");
  rejectUnknownKeys(
    input,
    new Set([
      "ok",
      "machineId",
      "bootId",
      "kernel",
      "node",
      "dockerServer",
      "architecture",
      "imageId",
      "workers",
      "wallTimeMs",
      "p95WorkerMs",
    ]),
    "remote evidence",
  );
  if (input.ok !== true) throw new Error("remote host did not report success");
  for (const field of [
    "machineId",
    "bootId",
    "kernel",
    "node",
    "dockerServer",
    "architecture",
    "imageId",
  ]) {
    if (typeof input[field] !== "string" || input[field].length < 1 || input[field].length > 512) {
      throw new Error(`remote evidence.${field} is invalid`);
    }
  }
  if (input.workers !== expected.workers) {
    throw new Error(
      `remote host ran ${String(input.workers)} workers, expected ${expected.workers}`,
    );
  }
  positiveInteger(input.wallTimeMs, "remote evidence.wallTimeMs");
  positiveInteger(input.p95WorkerMs, "remote evidence.p95WorkerMs");
  return input;
}
