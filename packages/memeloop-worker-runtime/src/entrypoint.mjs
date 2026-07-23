import { createHash } from "node:crypto";
import vm from "node:vm";

const MAX_ASSIGNMENT_BYTES = 1024 * 1024;
const MAX_SCRIPT_BYTES = 96 * 1024;
const MAX_SUMMARY_BYTES = 64 * 1024;
const RESULT_PREFIX = "MEMELOOP_RESULT ";

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

async function loadIsolatedScript(source, workload, emitted, state) {
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
          runAgent: () => bridge.unsupported('runAgent'),
          runAgents: () => bridge.unsupported('runAgents'),
          runSequential: () => bridge.unsupported('runSequential'),
          runParallel: () => bridge.unsupported('runParallel'),
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
  const reference = workload.spec.scriptReference;
  if (typeof reference !== "string" || !/^sha256:[a-f0-9]{64}$/.test(reference)) {
    throw new Error("the minimal worker image requires spec.scriptReference as a sha256 digest");
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
  const { script, context } = await loadIsolatedScript(source, workload, emitted, state);

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
