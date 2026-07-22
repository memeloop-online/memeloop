/**
 * Source of the isolated loop-worker child entry (plan Phase 4.2 / 24.18 / 24.35).
 *
 * The driver writes this plain-JS ESM program to a content-addressed temp
 * file and executes it with the host Node binary. It intentionally uses only
 * `node:crypto` so it runs identically from the source tree and the bundled
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

var cancelled = false;
process.on('SIGTERM', function () { cancelled = true; });

var SUMMARY_CAP = 8192;

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

async function runJob(job) {
  // networkAccess 'none' is enforceable here: script validation already bans
  // node: imports, so removing the ambient fetch/WebSocket globals closes the
  // remaining outbound channel. 'outbound-only' target restriction is NOT
  // enforced (reported honestly by the driver; same posture as the daemon).
  if (job.networkAccess === 'none') {
    globalThis.fetch = undefined;
    globalThis.WebSocket = undefined;
  }

  var digest = createHash('sha256').update(normalizeScript(job.source), 'utf8').digest('hex');
  if ('sha256:' + digest !== job.expectedDigest) {
    await send({
      type: 'outcome',
      phase: 'Failed',
      error: { code: 'INVALID', message: 'script digest mismatch in worker child', retryable: false },
    });
    process.exit(2);
  }

  var module = await import('data:text/javascript;base64,' + Buffer.from(job.source, 'utf8').toString('base64'));
  var script = module.default || module.run;
  if (typeof script !== 'function') {
    throw new Error('workload script must export a default function or named run function');
  }

  var emitted = [];
  var scriptState = new Map();
  var ctx = {
    input: job.input,
    emit: function (step) { emitted.push(step); },
    finish: function (message) {
      emitted.push(typeof message === 'string' ? { type: 'message', data: message } : message);
    },
    log: function (event) { void send({ type: 'log', event: String(event) }); },
    isCancelled: function () { return cancelled; },
    state: {
      get: async function (key) { return scriptState.get(key); },
      set: async function (key, value) { scriptState.set(key, value); },
      update: async function (key, updater) { scriptState.set(key, updater(scriptState.get(key))); },
    },
    checkpoint: async function () { return undefined; },
    loadCheckpoint: async function () { return undefined; },
    runAgent: unsupported('runAgent'),
    runAgents: unsupported('runAgents'),
    runSequential: unsupported('runSequential'),
    runParallel: unsupported('runParallel'),
  };
  for (var capability of ['orchestration', 'agentClient', 'scriptClient']) {
    Object.defineProperty(ctx, capability, {
      get: unsupported('' + capability),
    });
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

process.on('message', function (job) {
  runJob(job).then(undefined, async function (error) {
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
