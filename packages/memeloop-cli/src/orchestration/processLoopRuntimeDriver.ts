import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BUILTIN_RUNTIME_CLASSES,
  LOOP_CHECKPOINT_API_VERSION,
  LOOP_CHECKPOINT_SCHEMA_VERSION,
  type LoopCheckpointScope,
  type LoopRunHandle,
  type LoopRunOutcome,
  type LoopRunStartRequest,
  type LoopRuntimeDriver,
  type LoopScriptCheckpointStore,
  type ModelEndpointResource,
  OrchestrationError,
  parseWorkerCheckpointLoadPayload,
  parseWorkerCheckpointSavePayload,
  type RuntimeClassSpec,
  scopedLoopCheckpointKey,
  WORKER_CHECKPOINT_LIMITS,
} from 'memeloop';

import type { LinuxProcessSandbox } from '../sandbox/linuxProcessSandbox.js';
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
 * - Heap limit: `--max-old-space-size` is always applied. Production
 *   NodeRuntime supplies `osSandbox`, which additionally enforces cgroup v2
 *   CPU/RSS/swap/task limits.
 * - Linux host isolation: production process classes are advertised only
 *   after a real systemd/bubblewrap/setpriv probe. They run with PID, IPC,
 *   UTS, cgroup, user and mount isolation, a read-only minimal filesystem,
 *   no-new-privileges, dropped capabilities and a seccomp deny filter.
 * - Network: `none` and `outbound-only` classes have no direct IP path
 *   (network namespace plus cgroup IP deny). Their only outbound operation is
 *   the bounded, parent-mediated capability channel; `full` retains host
 *   networking. This is a strict subset of outbound-only, never a bypass.
 *
 * The only host-authority capability is bounded `runAgent` IPC. Resource,
 * script-deployment, provider-key, and orchestration authority remain absent
 * and fail explicitly.
 *
 * `ctx.checkpoint` and `ctx.state` below are durable script KV operations.
 * They do not snapshot the child process and therefore do not imply the
 * management driver's `supportsCheckpoint`/`supportsRestore` capabilities.
 */

export interface ProcessLoopRuntimeDriverOptions {
  /**
   * Trusted durable checkpoint/state boundary. Process workers receive only
   * run-scoped load/save IPC capabilities, never this store or its authority.
   */
  checkpointStore?: LoopScriptCheckpointStore;
  /** Model gateway endpoint exposed to the child as MEMELOOP_MODEL_GATEWAY (not a secret). */
  gatewayEndpoint?: string;
  /** Resolve a reachable gateway for an independently selected endpoint. */
  gatewayEndpointForModelEndpoint?: (
    endpoint: ModelEndpointResource,
    request: LoopRunStartRequest,
  ) => Promise<string | undefined>;
  /**
   * Trusted parent-side child-agent dispatcher. Calls cross the inherited IPC
   * descriptor; the isolated script receives no daemon/provider credential.
   */
  runChildAgent?: (input: {
    profileId: string;
    prompt: string;
    conversationId: string;
    signal?: AbortSignal;
    runId?: string;
  }) => AsyncIterable<unknown> | Promise<unknown>;
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
  /** Prepared cgroup/namespace/seccomp launcher for advertised process classes. */
  osSandbox?: LinuxProcessSandbox;
  logger?: { warn?: (...arguments_: unknown[]) => void };
}

interface ChildOutcomeMessage {
  type: 'outcome';
  phase: 'Completed' | 'Failed' | 'Cancelled';
  summary?: string;
  error?: { code: string; message: string; retryable: boolean };
}

interface ChildCapabilityRequest {
  type: 'capability-request';
  requestId: string;
  capability: ChildCapabilityName;
  input: unknown;
}

type ChildCapabilityName = 'runAgent' | 'checkpoint' | 'state';
type ChildCapabilityHandler = (input: unknown) => Promise<unknown>;

const MIB = 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 2000;
const DEFAULT_TIME_LIMIT_MS = 300_000;
const DEFAULT_MAX_STDERR_BYTES = 4096;
const MAX_CAPABILITY_REQUEST_BYTES = 32 * 1024;
const MAX_CAPABILITY_RESPONSE_BYTES = 256 * 1024;
const MAX_DURABLE_CAPABILITY_BYTES = WORKER_CHECKPOINT_LIMITS.valueBytes + 16 * 1024;
// A rolling ceiling permits long resumable scripts to exceed 100 lifetime
// steps while bounding worst-case durable ingress to 128 MiB/minute before
// the checkpoint store's own resource/CAS policy is applied.
const MAX_CAPABILITY_REQUESTS_PER_WINDOW = 256;
const CAPABILITY_RATE_WINDOW_MS = 60_000;
const MAX_CONCURRENT_CAPABILITIES = 8;

function jsonBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('worker capability value is not JSON');
  return Buffer.byteLength(encoded, 'utf8');
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

function isChildAlreadyExitedError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ESRCH' || code === 'ERR_IPC_CHANNEL_CLOSED' ||
    (error instanceof Error && /already exited|channel closed|not connected/iu.test(error.message));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: 'worker capability input must be an object',
      retryable: false,
    });
  }
  return value as Record<string, unknown>;
}

function runCheckpointConversationId(request: LoopRunStartRequest, scriptDigest: string): string {
  const { uid, generation } = request.run.metadata;
  // Reuse the canonical worker identifier validator for the raw durable
  // identity before hashing it into a fixed-width namespace.
  parseWorkerCheckpointLoadPayload({
    conversationId: uid,
    key: 'run-identity',
    scope: {
      scriptDigest,
      apiVersion: LOOP_CHECKPOINT_API_VERSION,
      schemaVersion: LOOP_CHECKPOINT_SCHEMA_VERSION,
      runId: uid,
    },
  });
  if (
    typeof generation !== 'number' ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: 'process worker run generation must be a positive safe integer',
      retryable: false,
    });
  }
  // AgentRun is the immutable attempt identity. spec.retry is policy/count,
  // not an attempt number; including it would hide durable state from the
  // same Run when only its retry policy representation changed.
  const digest = createHash('sha256')
    .update(JSON.stringify([uid, generation, scriptDigest, LOOP_CHECKPOINT_API_VERSION, LOOP_CHECKPOINT_SCHEMA_VERSION]), 'utf8')
    .digest('hex');
  return `looprun:${digest}`;
}

function stepText(step: unknown): string {
  if (typeof step === 'string') return step;
  if (step && typeof step === 'object') {
    const record = step as { type?: unknown; data?: unknown };
    if (record.type === 'message' && typeof record.data === 'string') return record.data;
  }
  return '';
}

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
    const checkpointStore = options.checkpointStore;
    if (!checkpointStore) {
      throw new OrchestrationError({
        code: 'UNSUPPORTED',
        message: `process LoopRuntimeDriver requires a durable checkpoint store (workload '${name}')`,
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
    const checkpointScope: LoopCheckpointScope = {
      scriptDigest: digestReference,
      apiVersion: LOOP_CHECKPOINT_API_VERSION,
      schemaVersion: LOOP_CHECKPOINT_SCHEMA_VERSION,
      runId: run.metadata.uid,
    };
    const conversationId = runCheckpointConversationId(request, digestReference);
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
    const nodeArguments = ['--experimental-vm-modules', workerPath];
    if (classSpec.memoryLimitBytes !== undefined) {
      nodeArguments.unshift(`--max-old-space-size=${Math.max(16, Math.floor(classSpec.memoryLimitBytes / MIB))}`);
    }

    const launch = options.osSandbox?.wrap({
      executable: nodeExecutable,
      arguments_: nodeArguments,
      runtimeClass: classSpec,
      workerPath,
      volumeMounts: request.volumeMounts,
    }) ?? { executable: nodeExecutable, arguments_: nodeArguments };
    const child: ChildProcess = spawn(launch.executable, launch.arguments_, {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      // Preserve non-JSON values (NaN, sparse arrays, exotic objects) until
      // the trusted parent canonical validator can reject them fail-closed.
      serialization: 'advanced',
    });

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
    const childAbortController = new AbortController();
    const capabilityRequestTimes: number[] = [];
    let activeCapabilities = 0;
    const durableLocks = new Map<string, Promise<void>>();

    const withDurableLock = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
      const previous = durableLocks.get(key);
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      durableLocks.set(key, current);
      if (previous) await previous;
      try {
        return await operation();
      } finally {
        release();
        if (durableLocks.get(key) === current) durableLocks.delete(key);
      }
    };

    const escalate = (signal: NodeJS.Signals): void => {
      try {
        child.kill(signal);
      } catch (error) {
        if (!isChildAlreadyExitedError(error)) {
          options.logger?.warn?.(`process worker '${name}' failed to accept ${signal}`, error);
        }
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch (error) {
          if (!isChildAlreadyExitedError(error)) {
            options.logger?.warn?.(`process worker '${name}' failed to accept SIGKILL`, error);
          }
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

    const runAgentCapability: ChildCapabilityHandler = async (value) => {
      if (!options.runChildAgent) throw new Error('worker child-agent capability is unavailable');
      const input = record(value);
      const profileId = typeof input.profileId === 'string'
        ? input.profileId
        : typeof input.profile === 'string'
        ? input.profile
        : undefined;
      if (
        !profileId ||
        typeof input.prompt !== 'string' ||
        typeof input.conversationId !== 'string' ||
        profileId.length > 256 ||
        input.prompt.length > 16_384 ||
        input.conversationId.length > 512
      ) {
        throw new Error('worker runAgent request is malformed');
      }
      const result = await options.runChildAgent({
        profileId,
        prompt: input.prompt,
        conversationId: input.conversationId,
        signal: childAbortController.signal,
        ...(typeof input.runId === 'string' ? { runId: input.runId } : {}),
      });
      const steps: unknown[] = [];
      let text = '';
      if (result && typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
        for await (const step of result as AsyncIterable<unknown>) {
          steps.push(step);
          text += stepText(step);
          if (jsonBytes({ steps, text }) > MAX_CAPABILITY_RESPONSE_BYTES) {
            throw new Error('worker capability response exceeds its bound');
          }
        }
      } else if (result !== undefined) {
        steps.push(result);
        text = stepText(result);
      }
      const response = { profileId, conversationId: input.conversationId, steps, text };
      if (jsonBytes(response) > MAX_CAPABILITY_RESPONSE_BYTES) {
        throw new Error('worker capability response exceeds its bound');
      }
      return response;
    };

    const durableCapability = (prefix: '' | 'state:'): ChildCapabilityHandler => async (value) => {
      const input = record(value);
      const operation = input.operation;
      const loadOperation = prefix === '' ? 'load' : 'get';
      const saveOperation = prefix === '' ? 'save' : 'set';
      const key = typeof input.key === 'string' ? `${prefix}${input.key}` : input.key;
      const rawKey = typeof input.key === 'string' ? input.key : undefined;
      if (!rawKey) throw new Error('worker durable key is malformed');
      const lockKey = `${conversationId}:${scopedLoopCheckpointKey(key, checkpointScope)}`;
      return withDurableLock(lockKey, async () => {
        if (operation === loadOperation || operation === 'get-record') {
          const requiredKeys = operation === 'get-record' ? ['operation', 'key'] : ['operation', 'key'];
          if (!hasExactKeys(input, requiredKeys)) {
            throw new Error('worker durable load request is malformed');
          }
          if (operation === 'get-record' && prefix !== 'state:') {
            throw new Error('worker durable record load is only available for state');
          }
          const parsed = parseWorkerCheckpointLoadPayload({
            conversationId,
            key,
            scope: checkpointScope,
          });
          const loaded = checkpointStore.loadCheckpointRecord
            ? await checkpointStore.loadCheckpointRecord(parsed.conversationId, parsed.key, { scope: checkpointScope })
            : undefined;
          const result = loaded?.result ?? await checkpointStore.loadCheckpoint(parsed.conversationId, parsed.key, { scope: checkpointScope });
          if (result !== undefined) {
            // Applying the save parser to a loaded value gives responses the
            // same canonical JSON/depth/node ceiling as writes.
            parseWorkerCheckpointSavePayload({
              ...parsed,
              value: result,
              expectedRevision: loaded?.revision ?? 0,
              fencingEpoch: loaded?.fencingEpoch ?? 0,
            });
          }
          if (operation === 'get-record') {
            return loaded
              ? { value: result, revision: loaded.revision, fencingEpoch: loaded.fencingEpoch }
              : { value: result };
          }
          return result;
        }
        if (operation === saveOperation) {
          if (
            !hasExactKeys(input, ['operation', 'key', 'value']) &&
            !hasExactKeys(input, ['operation', 'key', 'value', 'expectedRevision', 'fencingEpoch'])
          ) {
            throw new Error('worker durable save request is malformed');
          }
          const parsed = parseWorkerCheckpointSavePayload({
            conversationId,
            key,
            value: input.value,
            scope: checkpointScope,
            expectedRevision: typeof input.expectedRevision === 'number' ? input.expectedRevision : 0,
            fencingEpoch: typeof input.fencingEpoch === 'number' ? input.fencingEpoch : 0,
          });
          const current = checkpointStore.loadCheckpointRecord
            ? await checkpointStore.loadCheckpointRecord(parsed.conversationId, parsed.key, { scope: checkpointScope })
            : undefined;
          const expectedRevision = typeof input.expectedRevision === 'number'
            ? input.expectedRevision
            : current?.revision;
          const fencingEpoch = typeof input.fencingEpoch === 'number'
            ? input.fencingEpoch
            : current?.fencingEpoch;
          await checkpointStore.saveCheckpoint(parsed.conversationId, parsed.key, parsed.value, {
            scope: checkpointScope,
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
            ...(fencingEpoch === undefined ? {} : { fencingEpoch }),
          });
          return undefined;
        }
        throw new Error('worker durable capability operation is invalid');
      });
    };

    const capabilityHandlers = new Map<ChildCapabilityName, ChildCapabilityHandler>([
      ['runAgent', runAgentCapability],
      ['checkpoint', durableCapability('')],
      ['state', durableCapability('state:')],
    ]);

    const sendCapabilityResponse = (response: Record<string, unknown>): void => {
      if (!child.connected) return;
      try {
        child.send?.(response, (error) => {
          if (error && !isChildAlreadyExitedError(error)) {
            options.logger?.warn?.(`process worker '${name}' capability response delivery failed`, error);
          }
        });
      } catch (error) {
        if (!isChildAlreadyExitedError(error)) {
          options.logger?.warn?.(`process worker '${name}' capability response delivery failed`, error);
        }
      }
    };

    child.on('message', (message: ChildOutcomeMessage | ChildCapabilityRequest | { type?: string }) => {
      if (message && message.type === 'outcome') {
        outcomeMessage = message as ChildOutcomeMessage;
        return;
      }
      if (message && message.type === 'capability-request') {
        const capability = message as ChildCapabilityRequest;
        const requestedAt = Date.now();
        while (
          capabilityRequestTimes.length > 0 &&
          requestedAt - (capabilityRequestTimes[0] ?? requestedAt) >= CAPABILITY_RATE_WINDOW_MS
        ) {
          capabilityRequestTimes.shift();
        }
        const deny = (error: string): void => {
          sendCapabilityResponse({
            type: 'capability-response',
            requestId: capability.requestId,
            ok: false,
            error,
          });
        };
        const handler = capabilityHandlers.get(capability.capability);
        const requestLimit = capability.capability === 'runAgent'
          ? MAX_CAPABILITY_REQUEST_BYTES
          : MAX_DURABLE_CAPABILITY_BYTES;
        let requestBytes = Number.POSITIVE_INFINITY;
        try {
          requestBytes = jsonBytes(capability.input);
        } catch (error) {
          options.logger?.warn?.(
            `process worker '${name}' capability request was not serializable and was denied`,
            error,
          );
        }
        if (
          !handler ||
          !/^cap-[1-9]\d{0,8}$/u.test(capability.requestId) ||
          cancelRequested ||
          timedOut ||
          capabilityRequestTimes.length >= MAX_CAPABILITY_REQUESTS_PER_WINDOW ||
          activeCapabilities >= MAX_CONCURRENT_CAPABILITIES ||
          requestBytes > requestLimit
        ) {
          deny('worker capability request is unavailable or exceeds its policy');
          return;
        }
        capabilityRequestTimes.push(requestedAt);
        activeCapabilities += 1;
        void (async () => {
          try {
            const value = await handler(capability.input);
            const responseLimit = capability.capability === 'runAgent'
              ? MAX_CAPABILITY_RESPONSE_BYTES
              : MAX_DURABLE_CAPABILITY_BYTES;
            if (jsonBytes({ value }) > responseLimit) {
              throw new Error('worker capability response exceeds its bound');
            }
            if (cancelRequested || timedOut) throw new Error('worker capability request was cancelled');
            sendCapabilityResponse({
              type: 'capability-response',
              requestId: capability.requestId,
              ok: true,
              value,
            });
          } catch (error) {
            if (!cancelRequested && !timedOut) {
              options.logger?.warn?.(`process worker '${name}' ${capability.capability} capability failed`, error);
            }
            deny(`worker ${capability.capability} capability is unavailable or failed its policy`);
          } finally {
            activeCapabilities -= 1;
          }
        })();
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
        childAbortController.abort();
        escalate('SIGTERM');
      },
    };
  }

  return { start };
}
