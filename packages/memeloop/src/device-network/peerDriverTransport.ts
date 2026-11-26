import { canonicalJsonBytes, CanonicalJsonError } from '../encoding/canonicalJson.js';
import { createMethodDispatcher } from './methodDispatcher.js';
import type { DeviceRpcHandler } from './types.js';

export const PEER_DRIVER_PROTOCOL_VERSION = 'memeloop-peer-driver/v2';

export type PeerDriverScope = 'runtime' | 'model' | 'tool';

export interface PeerDriverAssignment {
  /** Protocol version used during capability negotiation. */
  version: typeof PEER_DRIVER_PROTOCOL_VERSION;
  /** Scoped driver domain. */
  scope: PeerDriverScope;
  /** Assignment ID for idempotency and tracking. */
  assignmentId: string;
  /** Target operation within the scope. */
  operation: string;
  /** Operation parameters. */
  parameters: unknown;
  /** Optional timeout in milliseconds. */
  timeoutMs?: number;
}

interface PeerDriverStatusBase {
  version: typeof PEER_DRIVER_PROTOCOL_VERSION;
  assignmentId: string;
}

export type PeerDriverStatus =
  | (PeerDriverStatusBase & { state: 'accepted' | 'running' })
  | (PeerDriverStatusBase & { state: 'completed'; result?: unknown; completedAt?: string })
  | (PeerDriverStatusBase & { state: 'failed'; error: string; completedAt?: string });

export interface PeerDriverCallOptions {
  signal?: AbortSignal;
}

export interface PeerDriverTransportOptions {
  /** Send a raw RPC to a peer. */
  sendRpc: (
    peerId: string,
    method: string,
    parameters: unknown,
    options?: PeerDriverCallOptions,
  ) => Promise<unknown>;
  /** Default timeout for assignments. */
  defaultTimeoutMs?: number;
}

export interface PeerDriverRequestContext {
  /** Authenticated transport identity; never sourced from request parameters. */
  remotePeerId: string;
  /** Aborts when the caller disconnects, cancels, or the assignment deadline expires. */
  signal?: AbortSignal;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MAX_ASSIGNMENT_ID_LENGTH = 256;
const MAX_OPERATION_LENGTH = 128;
const MAX_PARAMETERS_BYTES = 1024 * 1024;
const MAX_ENVELOPE_BYTES = MAX_PARAMETERS_BYTES + 4096;
const MAX_REFERENCE_BYTES = 4096;
const MAX_TIMEOUT_MS = 10 * 60_000;
export const PEER_DRIVER_DEFAULT_TIMEOUT_MS = 30_000;
const STATUS_STATES = new Set<PeerDriverStatus['state']>([
  'accepted',
  'running',
  'completed',
  'failed',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertCanonicalJson(value: unknown, field: string, maximumBytes: number): void {
  try {
    canonicalJsonBytes(value, {
      maxBytes: maximumBytes,
      maxStringBytes: maximumBytes,
      maxStringCodeUnits: maximumBytes,
    });
  } catch (error) {
    if (
      error instanceof CanonicalJsonError &&
      (error.code === 'max_bytes' ||
        error.code === 'max_string_bytes' ||
        error.code === 'max_string_code_units')
    ) {
      throw new Error(`Peer driver ${field} exceeds ${maximumBytes} bytes`, { cause: error });
    }
    throw new Error(`Invalid peer driver ${field}`, { cause: error });
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  field: string,
): void {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some(key => !Object.prototype.hasOwnProperty.call(value, key)) ||
    keys.some(key => !allowed.has(key))
  ) {
    throw new Error(`Invalid peer driver ${field}`);
  }
}

function assertIdentifier(value: unknown, field: string, maximumLength: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximumLength ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new Error(`Invalid peer driver ${field}`);
  }
}

function assertTimeout(value: unknown): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_TIMEOUT_MS
  ) {
    throw new Error('Invalid peer driver timeoutMs');
  }
}

function assertAssignment(value: unknown): asserts value is PeerDriverAssignment {
  assertCanonicalJson(value, 'assignment', MAX_ENVELOPE_BYTES);
  if (!isRecord(value)) throw new Error('Invalid peer driver assignment');
  assertExactKeys(
    value,
    ['version', 'scope', 'assignmentId', 'operation', 'parameters'],
    ['timeoutMs'],
    'assignment',
  );
  if (value.version !== PEER_DRIVER_PROTOCOL_VERSION) {
    throw new Error(`Unsupported peer driver protocol version: ${String(value.version)}`);
  }
  if (value.scope !== 'runtime' && value.scope !== 'model' && value.scope !== 'tool') {
    throw new Error('Invalid peer driver scope');
  }
  assertIdentifier(value.assignmentId, 'assignmentId', MAX_ASSIGNMENT_ID_LENGTH);
  assertIdentifier(value.operation, 'operation', MAX_OPERATION_LENGTH);
  if (value.timeoutMs !== undefined) assertTimeout(value.timeoutMs);
  assertCanonicalJson(value.parameters, 'parameters', MAX_PARAMETERS_BYTES);
}

function assertAssignmentInput(
  value: unknown,
): asserts value is Omit<PeerDriverAssignment, 'version'> {
  assertCanonicalJson(value, 'assignment', MAX_ENVELOPE_BYTES);
  if (!isRecord(value)) throw new Error('Invalid peer driver assignment');
  assertExactKeys(
    value,
    ['scope', 'assignmentId', 'operation', 'parameters'],
    ['timeoutMs'],
    'assignment',
  );
  if (value.scope !== 'runtime' && value.scope !== 'model' && value.scope !== 'tool') {
    throw new Error('Invalid peer driver scope');
  }
  assertIdentifier(value.assignmentId, 'assignmentId', MAX_ASSIGNMENT_ID_LENGTH);
  assertIdentifier(value.operation, 'operation', MAX_OPERATION_LENGTH);
  if (value.timeoutMs !== undefined) assertTimeout(value.timeoutMs);
  assertCanonicalJson(value.parameters, 'parameters', MAX_PARAMETERS_BYTES);
}

function assertAssignmentReference(value: unknown): asserts value is {
  version: typeof PEER_DRIVER_PROTOCOL_VERSION;
  assignmentId: string;
} {
  assertCanonicalJson(value, 'assignment reference', MAX_REFERENCE_BYTES);
  if (!isRecord(value)) throw new Error('Invalid peer driver assignment reference');
  assertExactKeys(value, ['version', 'assignmentId'], [], 'assignment reference');
  if (value.version !== PEER_DRIVER_PROTOCOL_VERSION) {
    throw new Error(`Unsupported peer driver protocol version: ${String(value.version)}`);
  }
  assertIdentifier(value.assignmentId, 'assignmentId', MAX_ASSIGNMENT_ID_LENGTH);
}

function assertStatus(value: unknown, assignmentId: string): asserts value is PeerDriverStatus {
  assertCanonicalJson(value, 'status response', MAX_ENVELOPE_BYTES);
  if (
    !isRecord(value) ||
    value.version !== PEER_DRIVER_PROTOCOL_VERSION ||
    value.assignmentId !== assignmentId ||
    !STATUS_STATES.has(value.state as PeerDriverStatus['state']) ||
    (value.error !== undefined &&
      (typeof value.error !== 'string' || value.error.length > 4096)) ||
    (value.completedAt !== undefined &&
      (typeof value.completedAt !== 'string' || !Number.isFinite(Date.parse(value.completedAt))))
  ) {
    throw new Error('Invalid peer driver status response');
  }
  const state = value.state as PeerDriverStatus['state'];
  const optionalKeys = state === 'completed'
    ? ['result', 'completedAt']
    : state === 'failed'
    ? ['error', 'completedAt']
    : [];
  assertExactKeys(
    value,
    state === 'failed'
      ? ['version', 'assignmentId', 'state', 'error']
      : ['version', 'assignmentId', 'state'],
    optionalKeys,
    'status response',
  );
  if ('result' in value) assertCanonicalJson(value.result, 'result', MAX_PARAMETERS_BYTES);
}

function createLinkedSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abortFromParent = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(parent?.reason ?? new Error('peer_driver_aborted'));
    }
  };
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener('abort', abortFromParent, { once: true });
  const timer = controller.signal.aborted
    ? undefined
    : setTimeout(() => {
      if (!controller.signal.aborted) controller.abort(new Error('peer_driver_timeout'));
    }, timeoutMs);
  return {
    signal: controller.signal,
    dispose(): void {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('peer_driver_aborted');
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      complete();
    };
    const abort = (): void => {
      finish(() => {
        reject(abortReason(signal));
      });
    };
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(
      value => {
        finish(() => {
          resolve(value);
        });
      },
      (error: unknown) => {
        finish(() => {
          reject(error instanceof Error ? error : new Error('peer_driver_rpc_failed'));
        });
      },
    );
  });
}

function raceWithOptionalSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return signal === undefined ? promise : raceWithSignal(promise, signal);
}

/**
 * Create a scoped peer driver transport that exchanges versioned assignments
 * and status through the device network. LLMs and callers use scoped
 * operations (runtime/model/tool) instead of raw node IDs and RPC methods.
 */
export function createPeerDriverTransport(options: PeerDriverTransportOptions) {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? PEER_DRIVER_DEFAULT_TIMEOUT_MS;
  assertTimeout(defaultTimeoutMs);

  async function call(
    peerId: string,
    method: string,
    parameters: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const linked = createLinkedSignal(signal, timeoutMs);
    try {
      linked.signal.throwIfAborted();
      return await raceWithSignal(
        options.sendRpc(peerId, method, parameters, {
          signal: linked.signal,
        }),
        linked.signal,
      );
    } finally {
      linked.dispose();
    }
  }

  async function submitAssignment(
    peerId: string,
    assignment: Omit<PeerDriverAssignment, 'version'>,
    callOptions: PeerDriverCallOptions = {},
  ): Promise<PeerDriverStatus> {
    assertAssignmentInput(assignment);
    const timeoutMs = assignment.timeoutMs ?? defaultTimeoutMs;
    const versionedAssignment: PeerDriverAssignment = {
      version: PEER_DRIVER_PROTOCOL_VERSION,
      ...assignment,
      timeoutMs,
    };
    assertAssignment(versionedAssignment);

    const result = await call(
      peerId,
      `${PEER_DRIVER_PROTOCOL_VERSION}/submit`,
      versionedAssignment,
      timeoutMs,
      callOptions.signal,
    );
    assertStatus(result, assignment.assignmentId);
    return result;
  }

  async function getAssignmentStatus(
    peerId: string,
    assignmentId: string,
    callOptions: PeerDriverCallOptions = {},
  ): Promise<PeerDriverStatus> {
    return assignmentReferenceCall('status', peerId, assignmentId, callOptions);
  }

  async function cancelAssignment(
    peerId: string,
    assignmentId: string,
    callOptions: PeerDriverCallOptions = {},
  ): Promise<PeerDriverStatus> {
    return assignmentReferenceCall('cancel', peerId, assignmentId, callOptions);
  }

  async function assignmentReferenceCall(
    operation: 'status' | 'cancel',
    peerId: string,
    assignmentId: string,
    callOptions: PeerDriverCallOptions,
  ): Promise<PeerDriverStatus> {
    assertIdentifier(assignmentId, 'assignmentId', MAX_ASSIGNMENT_ID_LENGTH);
    const reference = { version: PEER_DRIVER_PROTOCOL_VERSION, assignmentId };
    assertAssignmentReference(reference);
    const result = await call(
      peerId,
      `${PEER_DRIVER_PROTOCOL_VERSION}/${operation}`,
      reference,
      defaultTimeoutMs,
      callOptions.signal,
    );
    assertStatus(result, assignmentId);
    return result;
  }

  return {
    submitAssignment,
    getAssignmentStatus,
    cancelAssignment,
  };
}

/**
 * Create a DeviceRpcHandler that routes scoped driver protocol calls to the
 * appropriate local handlers.
 */
export function createPeerDriverRpcHandler(handlers: {
  onSubmit?: (
    assignment: PeerDriverAssignment,
    context: PeerDriverRequestContext,
  ) => Promise<PeerDriverStatus>;
  onStatus?: (
    assignmentId: string,
    context: PeerDriverRequestContext,
  ) => Promise<PeerDriverStatus>;
  onCancel?: (
    assignmentId: string,
    context: PeerDriverRequestContext,
  ) => Promise<PeerDriverStatus>;
}): DeviceRpcHandler {
  const referenceDispatch = createMethodDispatcher<'status' | 'cancel', {
    assignmentId: string;
    context: PeerDriverRequestContext;
  }, PeerDriverStatus>({
    status: ({ assignmentId, context }) => {
      if (!handlers.onStatus) throw new Error('No status handler registered');
      return handlers.onStatus(assignmentId, context);
    },
    cancel: ({ assignmentId, context }) => {
      if (!handlers.onCancel) throw new Error('No cancel handler registered');
      return handlers.onCancel(assignmentId, context);
    },
  }, method => new Error('Unknown peer driver protocol method: ' + method));

  return async (input) => {
    const { method, parameters } = input;

    if (method === `${PEER_DRIVER_PROTOCOL_VERSION}/submit`) {
      assertAssignment(parameters);
      const onSubmit = handlers.onSubmit;
      if (!onSubmit) {
        throw new Error('No submit handler registered');
      }
      const timeoutMs = parameters.timeoutMs ?? PEER_DRIVER_DEFAULT_TIMEOUT_MS;
      const linked = createLinkedSignal(input.signal, timeoutMs);
      const context: PeerDriverRequestContext = {
        remotePeerId: input.remotePeerId,
        signal: linked.signal,
      };
      let result: PeerDriverStatus;
      try {
        linked.signal.throwIfAborted();
        result = await raceWithSignal(
          onSubmit(parameters, context),
          linked.signal,
        );
      } finally {
        linked.dispose();
      }
      assertStatus(result, parameters.assignmentId);
      return result;
    }

    const referenceOperation = method === `${PEER_DRIVER_PROTOCOL_VERSION}/status`
      ? 'status'
      : method === `${PEER_DRIVER_PROTOCOL_VERSION}/cancel`
      ? 'cancel'
      : undefined;
    if (referenceOperation !== undefined) {
      assertAssignmentReference(parameters);
      input.signal?.throwIfAborted();
      const context: PeerDriverRequestContext = {
        remotePeerId: input.remotePeerId,
        signal: input.signal,
      };
      const result = await raceWithOptionalSignal(
        referenceDispatch(referenceOperation, {
          assignmentId: parameters.assignmentId,
          context,
        }),
        input.signal,
      );
      input.signal?.throwIfAborted();
      assertStatus(result, parameters.assignmentId);
      return result;
    }

    throw new Error('Unknown peer driver protocol method: ' + method);
  };
}
