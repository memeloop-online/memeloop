import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";

const MAX_ASSIGNMENT_BYTES = 1024 * 1024;
const MAX_SCRIPT_BYTES = 96 * 1024;
const MAX_SUMMARY_BYTES = 64 * 1024;
const RESULT_PREFIX = "MEMELOOP_RESULT ";
const MAX_BOOTSTRAP_BYTES = 16 * 1024;
const MAX_GATEWAY_RESPONSE_BYTES = 1024 * 1024;
const WORKER_PROTOCOL_VERSION = "worker.memeloop.io/v1alpha1";

let cancelled = false;
process.on("SIGTERM", () => {
  cancelled = true;
});

function fail(message, code = "INVALID", exitCode = 64) {
  process.stdout.write(
    `${RESULT_PREFIX}${JSON.stringify({ phase: "Failed", error: { code, message, retryable: false } })}\n`,
  );
  process.exitCode = exitCode;
}

function parseAssignment(name) {
  const value = process.env[name];
  if (value === undefined) return undefined;
  if (Buffer.byteLength(value, "utf8") > MAX_ASSIGNMENT_BYTES) {
    throw new Error(`${name} exceeds ${MAX_ASSIGNMENT_BYTES} bytes`);
  }
  const parsed = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must contain a JSON object`);
  }
  return parsed;
}

function canonicalize(value) {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  throw new Error("worker protocol values must be JSON-compatible");
}

function unsignedCanonicalBytes(value, signatureKey) {
  const copy = { ...value };
  delete copy[signatureKey];
  return Buffer.from(canonicalize(copy), "utf8");
}

function publicKeyFingerprint(publicKey) {
  const der = Buffer.from(publicKey, "base64url");
  const parsed = createPublicKey({ key: der, format: "der", type: "spki" });
  if (parsed.asymmetricKeyType !== "ed25519") throw new Error("gateway key must be Ed25519");
  return `sha256:${createHash("sha256").update(der).digest("base64url")}`;
}

function isSecureGatewayUrl(value) {
  const url = new URL(value);
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost"))
  );
}

async function boundedJsonResponse(response, limit = MAX_GATEWAY_RESPONSE_BYTES) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > limit) throw new Error(`worker gateway response exceeds ${limit} bytes`);
  const value = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("worker gateway returned a non-object response");
  }
  return value;
}

async function createWorkerGatewayClient(workload) {
  const bootstrapPath = process.env.MEMELOOP_WORKER_BOOTSTRAP_FILE;
  if (!bootstrapPath) return undefined;
  const stat = fs.statSync(bootstrapPath);
  if (!stat.isFile() || stat.size > MAX_BOOTSTRAP_BYTES) {
    throw new Error("worker bootstrap descriptor is missing or oversized");
  }
  const bootstrap = JSON.parse(fs.readFileSync(bootstrapPath, "utf8"));
  if (
    bootstrap?.apiVersion !== WORKER_PROTOCOL_VERSION ||
    typeof bootstrap.gatewayUrl !== "string" ||
    !isSecureGatewayUrl(bootstrap.gatewayUrl) ||
    typeof bootstrap.gatewayPublicKey !== "string" ||
    typeof bootstrap.gatewayKeyFingerprint !== "string" ||
    typeof bootstrap.enrollmentName !== "string" ||
    typeof bootstrap.bootstrapToken !== "string"
  ) {
    throw new Error("worker bootstrap descriptor is malformed or uses an insecure gateway");
  }
  if (publicKeyFingerprint(bootstrap.gatewayPublicKey) !== bootstrap.gatewayKeyFingerprint) {
    throw new Error("worker bootstrap gateway key fingerprint mismatch");
  }

  const pair = generateKeyPairSync("ed25519");
  const workerPublicKey = Buffer.from(
    pair.publicKey.export({ format: "der", type: "spki" }),
  ).toString("base64url");
  const workerKeyFingerprint = publicKeyFingerprint(workerPublicKey);
  const proofMessage = Buffer.from(
    `memeloop-worker-bootstrap-v1\n${bootstrap.enrollmentName}\n${bootstrap.bootstrapToken}`,
    "utf8",
  );
  const endpoint = bootstrap.gatewayUrl.replace(/\/$/, "");
  const bootstrapResponse = await fetch(`${endpoint}/v1/worker/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enrollmentName: bootstrap.enrollmentName,
      bootstrapToken: bootstrap.bootstrapToken,
      workerPublicKey,
      proofSignature: sign(null, proofMessage, pair.privateKey).toString("base64url"),
    }),
  });
  // Drop the only process-local reference immediately after the single-use exchange.
  bootstrap.bootstrapToken = "";
  if (!bootstrapResponse.ok) throw new Error(`worker bootstrap denied (${bootstrapResponse.status})`);
  const descriptor = await boundedJsonResponse(bootstrapResponse, 64 * 1024);
  if (
    descriptor.apiVersion !== WORKER_PROTOCOL_VERSION ||
    descriptor.workerKeyFingerprint !== workerKeyFingerprint ||
    descriptor.gatewayKeyFingerprint !== bootstrap.gatewayKeyFingerprint ||
    typeof descriptor.gatewaySignature !== "string" ||
    typeof descriptor.sessionName !== "string" ||
    typeof descriptor.audience !== "string" ||
    typeof descriptor.policyDigest !== "string" ||
    !descriptor.run ||
    typeof descriptor.run.uid !== "string" ||
    !Array.isArray(descriptor.allowedTargets) ||
    !descriptor.allowedTargets.includes(descriptor.run.uid)
  ) {
    throw new Error("worker bootstrap response scope is invalid");
  }
  const gatewayKey = createPublicKey({
    key: Buffer.from(bootstrap.gatewayPublicKey, "base64url"),
    format: "der",
    type: "spki",
  });
  if (
    !verify(
      null,
      unsignedCanonicalBytes(descriptor, "gatewaySignature"),
      gatewayKey,
      Buffer.from(descriptor.gatewaySignature, "base64url"),
    )
  ) {
    throw new Error("worker bootstrap response gateway signature is invalid");
  }

  let sequence = 0;
  return Object.freeze({
    runUid: descriptor.run.uid,
    async request(method, target, payload) {
      sequence += 1;
      const unsigned = {
        apiVersion: WORKER_PROTOCOL_VERSION,
        requestId: randomBytes(16).toString("base64url"),
        sessionName: descriptor.sessionName,
        sequence,
        nonce: randomBytes(16).toString("base64url"),
        deadline: new Date(Date.now() + 10_000).toISOString(),
        audience: descriptor.audience,
        run: descriptor.run,
        method,
        target,
        policyDigest: descriptor.policyDigest,
        payload,
      };
      const message = {
        ...unsigned,
        signature: sign(
          null,
          Buffer.from(canonicalize(unsigned), "utf8"),
          pair.privateKey,
        ).toString("base64url"),
      };
      const response = await fetch(`${endpoint}/v1/worker/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
      });
      const result = await boundedJsonResponse(response);
      if (!result.ok) {
        throw new Error(
          typeof result.error?.message === "string"
            ? result.error.message
            : `worker gateway denied request (${response.status})`,
        );
      }
      return result.payload;
    },
  });
}

function normalizeScript(source) {
  return (
    source
      .replace(/^\uFEFF/, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trim() + "\n"
  );
}

function messageText(step) {
  if (typeof step === "string") return step;
  if (step && typeof step === "object" && step.type === "message" && typeof step.data === "string")
    return step.data;
  return "";
}

async function loadIsolatedScript(source, workload, emitted, state, gateway) {
  const sandbox = vm.createContext(Object.create(null), {
    name: `memeloop:${workload.uid ?? workload.name}`,
    codeGeneration: { strings: false, wasm: false },
  });
  const bridge = Object.freeze(
    Object.assign(Object.create(null), {
      emit: (step) => emitted.push(step),
      finish: (message) =>
        emitted.push(typeof message === "string" ? { type: "message", data: message } : message),
      log: (event) => process.stderr.write(`[memeloop-worker] ${String(event)}\n`),
      isCancelled: () => cancelled,
      stateGet: async (key) => state.get(key),
      stateSet: async (key, value) => state.set(key, value),
      stateUpdate: async (key, update) => state.set(key, update(state.get(key))),
      runAgent: async (input) => {
        if (!gateway) {
          throw new Error("ctx.runAgent requires an authenticated worker bootstrap capability");
        }
        return gateway.request("capability.request", gateway.runUid, {
          kind: "runAgent",
          input,
        });
      },
      unsupported: (name) => {
        throw new Error(`ctx.${name} requires an authenticated worker bootstrap capability`);
      },
    }),
  );
  sandbox.__memeloopBridge = bridge;
  sandbox.__memeloopInput = JSON.stringify({
    conversationId: `external:${workload.namespace ?? "default"}:${workload.uid ?? workload.name}`,
    message: workload.name,
  });
  const context = vm.runInContext(
    `
      ((bridge, input) => {
        const state = Object.freeze({
          get: async (key) => bridge.stateGet(key),
          set: async (key, value) => bridge.stateSet(key, value),
          update: async (key, update) => bridge.stateUpdate(key, update),
        });
        const ctx = {
          input: Object.freeze(input),
          emit: (step) => bridge.emit(step),
          finish: (message) => bridge.finish(message),
          log: (event) => bridge.log(event),
          isCancelled: () => bridge.isCancelled(),
          state,
          checkpoint: async () => undefined,
          loadCheckpoint: async () => undefined,
          runAgent: (input) => bridge.runAgent(input),
          runAgents: (inputs) => Promise.all(inputs.map((input) => bridge.runAgent(input))),
          runSequential: async (input) => {
            const results = [];
            for (const agent of input?.agents ?? []) results.push(await bridge.runAgent(agent));
            return { results, failures: [], text: results.map((result) => result?.text ?? '').join('\\n\\n') };
          },
          runParallel: async (input) => {
            const results = await Promise.all((input?.agents ?? []).map((agent) => bridge.runAgent(agent)));
            return { results, failures: [], text: results.map((result) => result?.text ?? '').join('\\n\\n') };
          },
        };
        for (const capability of ['orchestration', 'agentClient', 'scriptClient']) {
          Object.defineProperty(ctx, capability, { get: () => bridge.unsupported(capability) });
        }
        return Object.freeze(ctx);
      })(globalThis.__memeloopBridge, JSON.parse(globalThis.__memeloopInput))
    `,
    sandbox,
  );
  delete sandbox.__memeloopBridge;
  delete sandbox.__memeloopInput;

  const module = new vm.SourceTextModule(source, {
    context: sandbox,
    identifier: `memeloop:artifact:${workload.spec.scriptReference}`,
  });
  await module.link((specifier) => {
    throw new Error(`worker runtime does not provide imported module '${specifier}'`);
  });
  await module.evaluate();
  const script = module.namespace.default;
  if (typeof script !== "function" || script.constructor.name !== "AsyncGeneratorFunction") {
    throw new Error("workload script must export a default async generator function");
  }
  return { script, context };
}

async function runWorkload(workload) {
  if (
    typeof workload.name !== "string" ||
    workload.spec === null ||
    typeof workload.spec !== "object"
  ) {
    throw new Error("MEMELOOP_WORKLOAD is missing name/spec");
  }
  const gateway = await createWorkerGatewayClient(workload);
  const reference = workload.spec.scriptReference;
  if (reference === undefined && typeof workload.spec.profileId === "string") {
    if (!gateway) {
      throw new Error("profile workloads require an authenticated worker bootstrap capability");
    }
    const assignment = await gateway.request("assignment.pull", gateway.runUid, {});
    if (
      assignment?.profileId !== workload.spec.profileId ||
      typeof assignment.prompt !== "string"
    ) {
      throw new Error("worker gateway returned an invalid profile assignment");
    }
    const result = await gateway.request("capability.request", gateway.runUid, {
      kind: "runAgent",
      input: {
        profileId: assignment.profileId,
        prompt: assignment.prompt,
      },
    });
    return {
      phase: cancelled ? "Cancelled" : "Completed",
      summary: typeof result?.text === "string" ? result.text : "",
    };
  }
  if (typeof reference !== "string" || !/^sha256:[a-f0-9]{64}$/.test(reference)) {
    throw new Error("worker workload requires a profileId or scriptReference sha256 digest");
  }
  const source = process.env.MEMELOOP_WORKLOAD_SCRIPT;
  if (source === undefined) throw new Error(`script source for '${reference}' was not supplied`);
  if (Buffer.byteLength(source, "utf8") > MAX_SCRIPT_BYTES)
    throw new Error(`script exceeds ${MAX_SCRIPT_BYTES} bytes`);
  const normalized = normalizeScript(source);
  const actual = `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
  if (actual !== reference)
    throw new Error(`script digest mismatch: expected ${reference}, received ${actual}`);

  const emitted = [];
  const state = new Map();
  const { script, context } = await loadIsolatedScript(source, workload, emitted, state, gateway);

  let summary = "";
  const append = (step) => {
    summary += messageText(step);
    if (Buffer.byteLength(summary, "utf8") > MAX_SUMMARY_BYTES) {
      summary =
        Buffer.from(summary, "utf8").subarray(0, MAX_SUMMARY_BYTES).toString("utf8") +
        "...[truncated]";
    }
  };
  const drain = () => {
    while (emitted.length > 0) append(emitted.shift());
  };

  const result = await script(context);
  drain();
  if (result && typeof result[Symbol.asyncIterator] === "function") {
    for await (const step of result) append(step);
    drain();
  } else if (Array.isArray(result)) {
    for (const step of result) append(step);
  } else {
    append(result);
  }
  return { phase: cancelled ? "Cancelled" : "Completed", summary };
}

async function runToolOperation(operation) {
  const toolName = operation?.toolRef?.name;
  if (toolName === "memeloop.runtime.health") {
    return { phase: "Completed", result: { value: { healthy: true } } };
  }
  if (toolName === "memeloop.runtime.echo") {
    return { phase: "Completed", result: { value: operation.arguments ?? {} } };
  }
  throw new Error(`tool '${String(toolName)}' is not built into the minimal runtime image`);
}

try {
  const workload = parseAssignment("MEMELOOP_WORKLOAD");
  const operation = parseAssignment("MEMELOOP_TOOL_OPERATION");
  if ((workload === undefined) === (operation === undefined)) {
    throw new Error("set exactly one of MEMELOOP_WORKLOAD or MEMELOOP_TOOL_OPERATION");
  }
  const outcome =
    workload !== undefined ? await runWorkload(workload) : await runToolOperation(operation);
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(outcome)}\n`);
  if (outcome.phase !== "Completed") process.exitCode = 1;
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
