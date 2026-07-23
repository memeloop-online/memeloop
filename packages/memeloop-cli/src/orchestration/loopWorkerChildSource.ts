/**
 * Source of the isolated loop-worker child entry (plan Phase 4.2 / 24.18 / 24.35).
 *
 * The driver writes this plain-JS ESM program to a content-addressed temp
 * file and executes it with the host Node binary. It intentionally uses only
 * `node:crypto` and `node:vm` so it runs identically from the source tree and the bundled
 * dist. The parent talks to it over the Node IPC channel (`process.send`),
 * so workload scripts cannot forge protocol messages via console output.
 *
 * Contract with the parent (`processLoopRuntimeDriver.ts`):
 * - Parent sends exactly one job:
 *   `{ source, expectedDigest, input: { conversationId, message }, networkAccess }`.
 * - Child re-verifies `sha256(normalize(source)) === expectedDigest` before
 *   import (fail-closed end-to-end integrity; the parent resolved the source
 *   from the content-addressed artifact store).
 * - Child replies `{ type: 'outcome', phase, summary?, error? }` then exits.
 *
 * NOTE: keep this free of backticks and `${` sequences — it is embedded as a
 * template literal below.
 */
export const LOOP_WORKER_CHILD_SOURCE = `// memeloop isolated loop worker (generated; see loopWorkerChildSource.ts)
import { createHash } from 'node:crypto';
import vm from 'node:vm';

var cancelled = false;
process.on('SIGTERM', function () { cancelled = true; });

var SUMMARY_CAP = 8192;
var capabilitySequence = 0;
var pendingCapabilities = new Map();

function send(message) {
  return new Promise(function (resolve) {
    if (typeof process.send !== 'function') { resolve(); return; }
    process.send(message, function () { resolve(); });
  });
}

function normalizeScript(source) {
  return source
    .replace(/^\\uFEFF/, '')
    .replace(/\\r\\n/g, '\\n')
    .replace(/\\r/g, '\\n')
    .split('\\n')
    .map(function (line) { return line.trimEnd(); })
    .join('\\n')
    .trim() + '\\n';
}

function extractMessageText(step) {
  if (typeof step === 'string') return step;
  if (step && typeof step === 'object') {
    if (step.type === 'message' && typeof step.data === 'string') return step.data;
  }
  return '';
}

function unsupported(name) {
  return function () {
    throw new Error(
      'ctx.' + name + ' is unavailable in the isolated process runtime (Phase 4.2): ' +
      'host-authority capabilities require the worker bootstrap channel'
    );
  };
}

function requestCapability(capability, input) {
  capabilitySequence += 1;
  var requestId = 'cap-' + capabilitySequence;
  return new Promise(function (resolve, reject) {
    pendingCapabilities.set(requestId, { resolve: resolve, reject: reject });
    send({ type: 'capability-request', requestId: requestId, capability: capability, input: input });
  });
}

async function runJob(job) {
  // networkAccess 'none' is enforceable here: script validation already bans
  // node: imports, so removing the ambient fetch/WebSocket globals closes the
  // remaining outbound channel. 'outbound-only' target restriction is NOT
  // enforced (reported honestly by the driver; same posture as the daemon).
  var digest = createHash('sha256').update(normalizeScript(job.source), 'utf8').digest('hex');
  if ('sha256:' + digest !== job.expectedDigest) {
    await send({
      type: 'outcome',
      phase: 'Failed',
      error: { code: 'INVALID', message: 'script digest mismatch in worker child', retryable: false },
    });
    process.exit(2);
  }

  var emitted = [];
  var scriptState = new Map();
  var sandbox = vm.createContext(Object.create(null), {
    name: 'memeloop-process-worker',
    codeGeneration: { strings: false, wasm: false },
  });
  var safeEnvironment = Object.freeze(Object.assign(Object.create(null), process.env));
  sandbox.process = Object.freeze({ env: safeEnvironment, pid: process.pid });
  if (job.networkAccess !== 'none') {
    sandbox.fetch = globalThis.fetch;
    sandbox.WebSocket = globalThis.WebSocket;
  }
  var bridge = Object.freeze(Object.assign(Object.create(null), {
    emit: function (step) { emitted.push(step); },
    finish: function (message) {
      emitted.push(typeof message === 'string' ? { type: 'message', data: message } : message);
    },
    log: function (event) { void send({ type: 'log', event: String(event) }); },
    isCancelled: function () { return cancelled; },
    stateGet: async function (key) { return scriptState.get(key); },
    stateSet: async function (key, value) { scriptState.set(key, value); },
    stateUpdate: async function (key, updater) { scriptState.set(key, updater(scriptState.get(key))); },
    runAgent: function (input) { return requestCapability('runAgent', input); },
    unsupported: function (name) { throw new Error('ctx.' + name + ' requires an authenticated worker capability'); },
  }));
  sandbox.__memeloopBridge = bridge;
  sandbox.__memeloopInput = JSON.stringify(job.input);
  var ctx = vm.runInContext(
    "((bridge,input)=>{var state=Object.freeze({" +
    "get:async(key)=>bridge.stateGet(key),set:async(key,value)=>bridge.stateSet(key,value)," +
    "update:async(key,update)=>bridge.stateUpdate(key,update)});" +
    "var runAgent=(input)=>bridge.runAgent(input);" +
    "var context={input:Object.freeze(input),emit:(step)=>bridge.emit(step)," +
    "finish:(message)=>bridge.finish(message),log:(event)=>bridge.log(event)," +
    "isCancelled:()=>bridge.isCancelled(),state:state,checkpoint:async()=>undefined," +
    "loadCheckpoint:async()=>undefined,runAgent:runAgent," +
    "runAgents:(inputs)=>Promise.all(inputs.map(runAgent))," +
    "runSequential:async(input)=>{var out=[];for(var item of (input&&input.agents)||[]){out.push(await runAgent(item));}return {results:out,text:out.map(x=>x.text||'').join('\\\\n\\\\n'),failures:[]};}," +
    "runParallel:async(input)=>{var out=await Promise.all(((input&&input.agents)||[]).map(runAgent));return {results:out,text:out.map(x=>x.text||'').join('\\\\n\\\\n'),failures:[]};}};" +
    "for(var name of ['orchestration','agentClient','scriptClient']){Object.defineProperty(context,name,{get:()=>bridge.unsupported(name)});}return Object.freeze(context);})(globalThis.__memeloopBridge,JSON.parse(globalThis.__memeloopInput))",
    sandbox,
  );
  delete sandbox.__memeloopBridge;
  delete sandbox.__memeloopInput;

  var module = new vm.SourceTextModule(job.source, {
    context: sandbox,
    identifier: 'memeloop:process-artifact:' + job.expectedDigest,
  });
  await module.link(function (specifier) {
    throw new Error("isolated process runtime does not provide imported module '" + specifier + "'");
  });
  await module.evaluate();
  var script = module.namespace.default || module.namespace.run;
  if (typeof script !== 'function') {
    throw new Error('workload script must export a default function or named run function');
  }

  var summary = '';
  function drainEmitted() {
    while (emitted.length > 0) {
      summary += extractMessageText(emitted.shift());
    }
  }

  var result = await script(ctx);
  drainEmitted();
  if (result && typeof result[Symbol.asyncIterator] === 'function') {
    for await (var step of result) {
      summary += extractMessageText(step);
    }
    drainEmitted();
  } else if (typeof result === 'string') {
    summary += result;
  } else if (Array.isArray(result)) {
    for (var entry of result) summary += extractMessageText(entry);
  } else if (result) {
    summary += extractMessageText(result);
  }
  if (summary.length > SUMMARY_CAP) {
    summary = summary.slice(0, SUMMARY_CAP) + '...[truncated]';
  }

  await send({ type: 'outcome', phase: cancelled ? 'Cancelled' : 'Completed', summary: summary });
  process.exit(0);
}

process.on('message', function (message) {
  if (message && message.type === 'capability-response') {
    var pending = pendingCapabilities.get(message.requestId);
    if (!pending) return;
    pendingCapabilities.delete(message.requestId);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new Error(message.error || 'worker capability failed'));
    return;
  }
  runJob(message).then(undefined, async function (error) {
    await send({
      type: 'outcome',
      phase: 'Failed',
      error: {
        code: 'INTERNAL',
        message: error && error.message ? String(error.message) : String(error),
        retryable: false,
      },
    });
    process.exit(1);
  });
});
`;
