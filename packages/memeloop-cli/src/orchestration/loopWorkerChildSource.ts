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

var SUMMARY_CAP = 8192;
var CAPABILITY_TIMEOUT_MS = 30000;
var RUN_AGENT_REQUEST_CAP = 32 * 1024;
var DURABLE_REQUEST_CAP = 512 * 1024 + 16 * 1024;
var JSON_DEPTH_CAP = 32;
var JSON_NODE_CAP = 50000;
var MAX_PENDING_CAPABILITIES = 8;
var capabilitySequence = 0;
var pendingCapabilities = new Map();

function send(message) {
  return new Promise(function (resolve, reject) {
    if (typeof process.send !== 'function' || !process.connected) {
      reject(new Error('worker capability channel is unavailable'));
      return;
    }
    process.send(message, function (error) {
      if (error) reject(error);
      else resolve();
    });
  });
}

function reportLogForwardingFailure(error) {
  var detail = error && error.message ? String(error.message) : String(error);
  if (detail.length > 256) detail = detail.slice(0, 256) + '...[truncated]';
  try {
    process.stderr.write('worker log forwarding failed: ' + detail + '\\n');
  } catch (_) {
    // The child is already disconnected; make the failure terminal when even
    // the bounded stderr report cannot be emitted.
    process.exitCode = 1;
  }
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

function capabilityRequestLimit(capability) {
  return capability === 'runAgent' ? RUN_AGENT_REQUEST_CAP : DURABLE_REQUEST_CAP;
}

function hasValidUnicode(value) {
  for (var index = 0; index < value.length; index += 1) {
    var unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      var next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
      index += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

function normalizeStrictJson(root, maximumBytes) {
  var active = new Set();
  var nodes = 0;
  function consumeNode() {
    nodes += 1;
    if (nodes > JSON_NODE_CAP) throw new Error('worker capability JSON exceeds its node bound');
  }
  function validateString(value) {
    if (!hasValidUnicode(value) || Buffer.byteLength(value, 'utf8') > maximumBytes) {
      throw new Error('worker capability JSON string is invalid');
    }
  }
  function walk(value, depth) {
    if (depth > JSON_DEPTH_CAP) throw new Error('worker capability JSON exceeds its depth bound');
    consumeNode();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') { validateString(value); return value; }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('worker capability JSON number is invalid');
      return value;
    }
    if (typeof value !== 'object') throw new Error('worker capability value is not strict JSON');
    if (active.has(value)) throw new Error('worker capability JSON is cyclic');
    active.add(value);
    try {
      if (Array.isArray(value)) {
        var arrayKeys = Reflect.ownKeys(value);
        if (arrayKeys.length !== value.length + 1 || arrayKeys.some(function (key) { return typeof key !== 'string'; })) {
          throw new Error('worker capability JSON array is sparse or has extra properties');
        }
        var outputArray = [];
        for (var arrayIndex = 0; arrayIndex < value.length; arrayIndex += 1) {
          var arrayDescriptor = Object.getOwnPropertyDescriptor(value, String(arrayIndex));
          if (!arrayDescriptor || !arrayDescriptor.enumerable || !Object.hasOwn(arrayDescriptor, 'value')) {
            throw new Error('worker capability JSON array property is invalid');
          }
          outputArray.push(walk(arrayDescriptor.value, depth + 1));
        }
        return outputArray;
      }
      var prototype = Object.getPrototypeOf(value);
      if (prototype !== null) {
        var constructorDescriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
        if (
          !constructorDescriptor ||
          !Object.hasOwn(constructorDescriptor, 'value') ||
          typeof constructorDescriptor.value !== 'function' ||
          constructorDescriptor.value.name !== 'Object'
        ) {
          throw new Error('worker capability JSON object is not plain');
        }
      }
      var outputObject = Object.create(null);
      for (var key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') throw new Error('worker capability JSON symbol key is invalid');
        validateString(key);
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          throw new Error('worker capability JSON key is unsafe');
        }
        consumeNode();
        var descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw new Error('worker capability JSON property is invalid');
        }
        outputObject[key] = walk(descriptor.value, depth + 1);
      }
      return outputObject;
    } finally {
      active.delete(value);
    }
  }
  var normalized = walk(root, 0);
  var encoded = JSON.stringify(normalized);
  if (Buffer.byteLength(encoded, 'utf8') > maximumBytes) {
    throw new Error('worker capability JSON exceeds its byte bound');
  }
  return normalized;
}

function requestCapability(capability, input) {
  if (cancelled) return Promise.reject(new Error('worker capability request was cancelled'));
  if (pendingCapabilities.size >= MAX_PENDING_CAPABILITIES) {
    return Promise.reject(new Error('worker capability concurrency exceeds its bound'));
  }
  capabilitySequence += 1;
  var requestId = 'cap-' + capabilitySequence;
  var limit = capabilityRequestLimit(capability);
  var normalizedInput = normalizeStrictJson(input, limit);
  var message = { type: 'capability-request', requestId: requestId, capability: capability, input: normalizedInput };
  var encoded = JSON.stringify(message);
  if (Buffer.byteLength(encoded, 'utf8') > limit) {
    return Promise.reject(new Error('worker capability request exceeds its bound'));
  }
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      pendingCapabilities.delete(requestId);
      reject(new Error('worker capability request timed out'));
    }, CAPABILITY_TIMEOUT_MS);
    pendingCapabilities.set(requestId, { resolve: resolve, reject: reject, timer: timer });
    send(message).catch(function (error) {
      var pending = pendingCapabilities.get(requestId);
      if (!pending) return;
      pendingCapabilities.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    });
  });
}

process.on('SIGTERM', function () {
  cancelled = true;
  for (var pending of pendingCapabilities.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error('worker capability request was cancelled'));
  }
  pendingCapabilities.clear();
});

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
    log: function (event) {
      void send({ type: 'log', event: String(event) }).catch(reportLogForwardingFailure);
    },
    isCancelled: function () { return cancelled; },
    stateGet: function (key) {
      return requestCapability('state', { operation: 'get', key: key });
    },
    stateSet: function (key, value) {
      return requestCapability('state', { operation: 'set', key: key, value: value });
    },
    stateUpdate: async function (key, updater) {
      var current = await requestCapability('state', { operation: 'get-record', key: key });
      var previous = current && typeof current === 'object' ? current.value : undefined;
      var next = updater(previous);
      var mutation = { operation: 'set', key: key, value: next };
      if (current && typeof current === 'object' && typeof current.revision === 'number') {
        mutation.expectedRevision = current.revision;
      }
      if (current && typeof current === 'object' && typeof current.fencingEpoch === 'number') {
        mutation.fencingEpoch = current.fencingEpoch;
      }
      await requestCapability('state', mutation);
    },
    checkpoint: function (key, value) {
      return requestCapability('checkpoint', { operation: 'save', key: key, value: value });
    },
    loadCheckpoint: function (key) {
      return requestCapability('checkpoint', { operation: 'load', key: key });
    },
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
    "isCancelled:()=>bridge.isCancelled(),state:state," +
    "checkpoint:(key,value)=>bridge.checkpoint(key,value)," +
    "loadCheckpoint:(key)=>bridge.loadCheckpoint(key),runAgent:runAgent," +
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
    clearTimeout(pending.timer);
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
