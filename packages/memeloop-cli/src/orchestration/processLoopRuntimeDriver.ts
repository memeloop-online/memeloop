import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BUILTIN_RUNTIME_CLASSES,
  type LoopRunHandle,
  type LoopRunOutcome,
  type LoopRunStartRequest,
  type LoopRuntimeDriver,
  type ModelEndpointResource,
  OrchestrationError,
  type RuntimeClassSpec,
} from 'memeloop';

import { LOOP_WORKER_CHILD_SOURCE } from './loopWorkerChildSource.js';
import { sanitizeWorkerEnvironment } from './workerEnvironment.js';

/**
 * Isolated child-process LoopRuntimeDriver (plan Phase 4.2, 24.18 debt, 24.35
 * consumption point).
 *
 * Runs a script workload in a dedicated Node child process so the RuntimeClass
 * `isolation: 'process'` declaration is real. Enforcement posture (reported
 * honestly, mirroring 24.39):
 *
 * - Address-space isolation: the script never shares the daemon's heap or
 *   module registry (hard — OS process boundary).
 * - Environment: `sanitizeWorkerEnvironment` strips provider keys from the
 *   inherited env; workload `spec.env` passes the same secret guard. No
 *   credentials reach argv, env, config, or crash diagnostics (24.35).
 * - Wall-clock limit: SIGTERM → SIGKILL escalation (hard).
 * - Heap limit: `--max-old-space-size` from the class `memoryLimitBytes`
 *   (cooperative — enforced by the host's own V8; RSS is NOT limited without
 *   cgroups, which remain future work).
 * - Network: script admission already bans node: imports; classes with
 *   `networkAccess: 'none'` additionally lose ambient fetch/WebSocket in the
 *   child. Target restriction for 'outbound-only' is NOT enforced (same
 *   posture as the daemon itself) — declared, not silently claimed.
 * - No cgroups/namespace/seccomp yet; CPU/RSS hard limits are future work.
 *
 * Host-authority capabilities (runAgent, agentClient, scriptClient,
 * orchestration) are absent in the child and fail with an explicit error —
 * they arrive with the worker bootstrap channel (24.35) and ModelGateway.
 */

export interface ProcessLoopRuntimeDriverOptions {
  /** Model gateway endpoint exposed to the child as MEMELOOP_MODEL_GATEWAY (not a secret). */
  gatewayEndpoint?: string;
  /** Resolve a reachable gateway for an independently selected endpoint. */
  gatewayEndpointForModelEndpoint?: (
    endpoint: ModelEndpointResource,
    request: LoopRunStartRequest,
  ) => Promise<string | undefined>;
  /** Extra env var names to keep despite the secret pattern. */
  keepEnv?: string[];
  /** Resolve the already-prepared attachment's non-secret environment patch. */
  environmentForNetworkAttachment?: (
    handle: string,
    request: LoopRunStartRequest,
  ) => Promise<Record<string, string> | undefined>;
  /** Environment to sanitize (default: process.env). */
  baseEnvironment?: NodeJS.ProcessEnv;
  /** RuntimeClass specs by name (defaults to the built-in classes). */
  runtimeClasses?: Record<string, RuntimeClassSpec>;
  /** Grace period between SIGTERM and SIGKILL (default 2000 ms). */
  killGraceMs?: number;
  /** Bounded stderr tail kept for crash diagnostics (default 4096 bytes). */
  maxStderrBytes?: number;
  /** Node executable for the child (default: process.execPath). */
  nodeExecutable?: string;
  logger?: { warn?: (...arguments_: unknown[]) => void };
}

interface ChildOutcomeMessage {
  type: 'outcome';
  phase: 'Completed' | 'Failed' | 'Cancelled';
  summary?: string;
  error?: { code: string; message: string; retryable: boolean };
}

const MIB = 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 2000;
const DEFAULT_TIME_LIMIT_MS = 300_000;
const DEFAULT_MAX_STDERR_BYTES = 4096;

let workerFilePromise: Promise<string> | undefined;

/**
 * Write the child entry to a content-addressed temp file (once per host
 * process; atomic via rename so concurrent daemons converge on one file).
 */
function ensureWorkerFile(): Promise<string> {
  workerFilePromise ??= (async () => {
    const digest = createHash('sha256').update(LOOP_WORKER_CHILD_SOURCE, 'utf8').digest('hex').slice(0, 16);
    const target = path.join(os.tmpdir(), `memeloop-loop-worker-${digest}.mjs`);
    if (!fs.existsSync(target)) {
      const temporary = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, LOOP_WORKER_CHILD_SOURCE, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, target);
    }
    return target;
  })();
  return workerFilePromise;
}

export function createProcessLoopRuntimeDriver(options: ProcessLoopRuntimeDriverOptions = {}): LoopRuntimeDriver {
  const runtimeClasses = options.runtimeClasses ?? BUILTIN_RUNTIME_CLASSES;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;

  async function start(request: LoopRunStartRequest): Promise<LoopRunHandle> {
    const { workload, run } = request;
    const name = workload.metadata.name;
    let gatewayEndpoint = options.gatewayEndpoint;

    if (!workload.spec.scriptReference || !request.scriptSource) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: `process LoopRuntimeDriver requires a script workload with resolved source (workload '${name}')`,
        retryable: false,
      });
    }
    const digestReference = workload.spec.scriptReference;
    if (!/^sha256:[a-f0-9]{64}$/.test(digestReference)) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: `workload '${name}' scriptReference '${digestReference}' is not a sha256 content digest`,
        retryable: false,
      });
    }
    const className = workload.spec.runtimeClass ?? '';
    const classSpec = runtimeClasses[className];
    if (!classSpec) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: `workload '${name}' references unknown RuntimeClass '${className}' — fail-closed (plan 24.18)`,
        retryable: false,
      });
    }
    if (workload.spec.modelPolicy?.modelClass) {
      const endpoint = request.modelEndpoint;
      if (
        !endpoint ||
        run.status?.assignedModelEndpoint?.uid !== endpoint.metadata.uid ||
        endpoint.spec.modelClassRef.name !== workload.spec.modelPolicy.modelClass
      ) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: `run '${run.metadata.name}' has no valid fenced ModelEndpoint binding`,
          retryable: false,
        });
      }
      if (options.gatewayEndpointForModelEndpoint) {
        gatewayEndpoint = await options.gatewayEndpointForModelEndpoint(endpoint, request);
      } else if (endpoint.spec.nodeId !== workload.status?.assignedNode) {
        gatewayEndpoint = undefined;
      }
      if (!gatewayEndpoint) {
        throw new OrchestrationError({
          code: 'UNSUPPORTED',
          message: `ModelEndpoint '${endpoint.metadata.name}' has no reachable process-worker gateway`,
          retryable: false,
        });
      }
    }
    let networkEnvironment: Record<string, string> | undefined;
    if (workload.spec.networkPolicy?.networkClass) {
      const attachment = request.networkAttachment;
      if (
        !attachment ||
        attachment.status?.phase !== 'Attached' ||
        !attachment.status.handle ||
        attachment.status.assignedNode !== workload.status?.assignedNode
      ) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: `workload '${name}' has no valid attached network binding`,
          retryable: false,
        });
      }
      networkEnvironment = await options.environmentForNetworkAttachment?.(
        attachment.status.handle,
        request,
      );
      if (!networkEnvironment) {
        throw new OrchestrationError({
          code: 'UNSUPPORTED',
          message: `NetworkAttachment '${attachment.metadata.name}' has no process environment consumer`,
          retryable: false,
        });
      }
    }
    const volumeEnvironment: Record<string, string> = {};
    for (const mount of request.volumeMounts ?? []) {
      const suffix = mount.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
      if (!suffix || volumeEnvironment[`MEMELOOP_VOLUME_${suffix}`]) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: `volume mount name '${mount.name}' is empty or collides after normalization`,
          retryable: false,
        });
      }
      volumeEnvironment[`MEMELOOP_VOLUME_${suffix}`] = mount.mountPath;
      volumeEnvironment[`MEMELOOP_VOLUME_${suffix}_READ_ONLY`] = String(mount.readOnly);
    }

    // 24.35: the child never sees provider keys — not via inherited env and
    // not via the workload spec (secret-shaped extras are stripped here and
    // were already rejected at admission).
    const { environment, stripped } = sanitizeWorkerEnvironment({
      ...(options.baseEnvironment !== undefined ? { baseEnvironment: options.baseEnvironment } : {}),
      ...(options.keepEnv !== undefined ? { keep: options.keepEnv } : {}),
      ...(gatewayEndpoint !== undefined ? { gatewayEndpoint } : {}),
      ...(
        workload.spec.env !== undefined ||
          networkEnvironment !== undefined ||
          Object.keys(volumeEnvironment).length > 0
          ? { extra: { ...workload.spec.env, ...networkEnvironment, ...volumeEnvironment } }
          : {}
      ),
    });
    if (stripped.length > 0) {
      options.logger?.warn?.(`process runtime stripped secret-shaped env for workload '${name}':`, stripped.join(', '));
    }

    const workerPath = await ensureWorkerFile();
    const nodeArguments = [workerPath];
    if (classSpec.memoryLimitBytes !== undefined) {
      nodeArguments.unshift(`--max-old-space-size=${Math.max(16, Math.floor(classSpec.memoryLimitBytes / MIB))}`);
    }

    const child: ChildProcess = spawn(nodeExecutable, nodeArguments, {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    const conversationId = `looprun:${run.metadata.namespace ?? 'default'}:${run.metadata.name}`;
    const timeLimitMs = classSpec.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS;

    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-maxStderrBytes);
    });
    // stdout carries only script console output; protocol uses IPC so script
    // output cannot forge outcomes. Drain to avoid backpressure.
    child.stdout?.resume();

    let cancelRequested = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let outcomeMessage: ChildOutcomeMessage | undefined;

    const escalate = (signal: NodeJS.Signals): void => {
      try {
        child.kill(signal);
      } catch {
        // already exited
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already exited
        }
      }, killGraceMs);
      killTimer.unref?.();
    };

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('error', () => {
        resolve({ code: null, signal: null });
      });
      child.once('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });

    child.on('message', (message: ChildOutcomeMessage | { type?: string }) => {
      if (message && message.type === 'outcome') {
        outcomeMessage = message as ChildOutcomeMessage;
      }
    });

    child.send?.({
      source: request.scriptSource,
      expectedDigest: digestReference,
      input: { conversationId, message: request.message ?? name },
      networkAccess: classSpec.networkAccess,
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      escalate('SIGTERM');
    }, timeLimitMs);
    timeoutTimer.unref?.();

    const waitPromise = (async (): Promise<LoopRunOutcome> => {
      const { code, signal } = await exitPromise;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);

      if (cancelRequested) {
        return { phase: 'Cancelled', summary: outcomeMessage?.summary };
      }
      if (timedOut) {
        return {
          phase: 'Failed',
          error: {
            code: 'TIMEOUT',
            message: `workload '${name}' exceeded RuntimeClass '${className}' wall-clock limit of ${timeLimitMs}ms`,
            retryable: false,
          },
        };
      }
      if (outcomeMessage) {
        if (outcomeMessage.phase === 'Completed') {
          return { phase: 'Completed', summary: outcomeMessage.summary };
        }
        if (outcomeMessage.phase === 'Cancelled') {
          return { phase: 'Cancelled', summary: outcomeMessage.summary };
        }
        return {
          phase: 'Failed',
          error: outcomeMessage.error ?? { code: 'INTERNAL', message: 'worker child reported failure', retryable: false },
        };
      }
      // Crash diagnostics contain the bounded stderr tail only — the child
      // env carried no secrets (24.35).
      const detail = stderrTail.trim() ? `: ${stderrTail.trim().slice(-500)}` : '';
      return {
        phase: 'Failed',
        error: {
          code: 'INTERNAL',
          message: `worker child exited without an outcome (code ${String(code)}, signal ${String(signal)})${detail}`,
          retryable: false,
        },
      };
    })();

    return {
      wait: () => waitPromise,
      async cancel() {
        if (cancelRequested) return;
        cancelRequested = true;
        escalate('SIGTERM');
      },
    };
  }

  return { start };
}
