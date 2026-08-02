import type { DeviceRpcHandler } from './types.js';

export const PEER_DRIVER_PROTOCOL_VERSION = 'memeloop-peer-driver/v2';

export type PeerDriverScope = 'runtime' | 'model' | 'tool';

export interface PeerDriverAssignment {
  /** Protocol version for forward compatibility. */
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

export interface PeerDriverStatus {
  version: typeof PEER_DRIVER_PROTOCOL_VERSION;
  assignmentId: string;
  state: 'accepted' | 'running' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
  completedAt?: string;
}

export interface PeerDriverTransportOptions {
  /** Send a raw RPC to a peer. */
  sendRpc: (peerId: string, method: string, parameters: unknown) => Promise<unknown>;
  /** Default timeout for assignments. */
  defaultTimeoutMs?: number;
}

export interface PeerDriverRequestContext {
  /** Authenticated transport identity; never sourced from request parameters. */
  remotePeerId: string;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MAX_ASSIGNMENT_ID_LENGTH = 256;
const MAX_OPERATION_LENGTH = 128;
const MAX_PARAMETERS_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 10 * 60_000;
const STATUS_STATES = new Set<PeerDriverStatus['state']>([
  'accepted',
  'running',
  'completed',
  'failed',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function assertBoundedJson(value: unknown, field: string): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`Invalid peer driver ${field}`);
  }
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > MAX_PARAMETERS_BYTES) {
    throw new Error(`Peer driver ${field} exceeds ${MAX_PARAMETERS_BYTES} bytes`);
  }
}

function assertAssignment(value: unknown): asserts value is PeerDriverAssignment {
  if (!isRecord(value)) throw new Error('Invalid peer driver assignment');
  if (value.version !== PEER_DRIVER_PROTOCOL_VERSION) {
    throw new Error(`Unsupported peer driver protocol version: ${String(value.version)}`);
  }
  if (value.scope !== 'runtime' && value.scope !== 'model' && value.scope !== 'tool') {
    throw new Error('Invalid peer driver scope');
  }
  assertIdentifier(value.assignmentId, 'assignmentId', MAX_ASSIGNMENT_ID_LENGTH);
  assertIdentifier(value.operation, 'operation', MAX_OPERATION_LENGTH);
  if (
    value.timeoutMs !== undefined &&
    (typeof value.timeoutMs !== 'number' ||
      !Number.isSafeInteger(value.timeoutMs) ||
      value.timeoutMs < 1 ||
      value.timeoutMs > MAX_TIMEOUT_MS)
  ) {
    throw new Error('Invalid peer driver timeoutMs');
  }
  if (!('parameters' in value)) throw new Error('Invalid peer driver parameters');
  assertBoundedJson(value.parameters, 'parameters');
}

function assertAssignmentReference(value: unknown): asserts value is {
  version: typeof PEER_DRIVER_PROTOCOL_VERSION;
  assignmentId: string;
} {
  if (!isRecord(value)) throw new Error('Invalid peer driver assignment reference');
  if (value.version !== PEER_DRIVER_PROTOCOL_VERSION) {
    throw new Error(`Unsupported peer driver protocol version: ${String(value.version)}`);
  }
  assertIdentifier(value.assignmentId, 'assignmentId', MAX_ASSIGNMENT_ID_LENGTH);
}

function assertStatus(value: unknown, assignmentId: string): asserts value is PeerDriverStatus {
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
  if ('result' in value) assertBoundedJson(value.result, 'result');
}

/**
 * Create a scoped peer driver transport that exchanges versioned assignments
 * and status through the device network. LLMs and callers use scoped
 * operations (runtime/model/tool) instead of raw node IDs and RPC methods.
 */
export function createPeerDriverTransport(options: PeerDriverTransportOptions) {
  async function submitAssignment(
    peerId: string,
    assignment: Omit<PeerDriverAssignment, 'version'>,
  ): Promise<PeerDriverStatus> {
    const versionedAssignment: PeerDriverAssignment = {
      version: PEER_DRIVER_PROTOCOL_VERSION,
      ...assignment,
    };
    assertAssignment(versionedAssignment);

    const result = await options.sendRpc(
      peerId,
      `${PEER_DRIVER_PROTOCOL_VERSION}/submit`,
      versionedAssignment,
    );
    assertStatus(result, assignment.assignmentId);
    return result;
  }

  async function getAssignmentStatus(
    peerId: string,
    assignmentId: string,
  ): Promise<PeerDriverStatus> {
    assertIdentifier(assignmentId, 'assignmentId', MAX_ASSIGNMENT_ID_LENGTH);
    const result = await options.sendRpc(
      peerId,
      `${PEER_DRIVER_PROTOCOL_VERSION}/status`,
      { version: PEER_DRIVER_PROTOCOL_VERSION, assignmentId },
    );
    assertStatus(result, assignmentId);
    return result;
  }

  async function cancelAssignment(
    peerId: string,
    assignmentId: string,
  ): Promise<PeerDriverStatus> {
    assertIdentifier(assignmentId, 'assignmentId', MAX_ASSIGNMENT_ID_LENGTH);
    const result = await options.sendRpc(
      peerId,
      `${PEER_DRIVER_PROTOCOL_VERSION}/cancel`,
      { version: PEER_DRIVER_PROTOCOL_VERSION, assignmentId },
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
  return async (input) => {
    const { method, parameters } = input;
    const context: PeerDriverRequestContext = { remotePeerId: input.remotePeerId };

    if (method === `${PEER_DRIVER_PROTOCOL_VERSION}/submit`) {
      assertAssignment(parameters);
      if (!handlers.onSubmit) {
        throw new Error('No submit handler registered');
      }
      const result = await handlers.onSubmit(parameters, context);
      assertStatus(result, parameters.assignmentId);
      return result;
    }

    if (method === `${PEER_DRIVER_PROTOCOL_VERSION}/status`) {
      assertAssignmentReference(parameters);
      if (!handlers.onStatus) {
        throw new Error('No status handler registered');
      }
      const result = await handlers.onStatus(parameters.assignmentId, context);
      assertStatus(result, parameters.assignmentId);
      return result;
    }

    if (method === `${PEER_DRIVER_PROTOCOL_VERSION}/cancel`) {
      assertAssignmentReference(parameters);
      if (!handlers.onCancel) {
        throw new Error('No cancel handler registered');
      }
      const result = await handlers.onCancel(parameters.assignmentId, context);
      assertStatus(result, parameters.assignmentId);
      return result;
    }

    throw new Error('Unknown peer driver protocol method: ' + method);
  };
}
