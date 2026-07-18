import type { DeviceRpcHandler } from './types.js';

export const PEER_DRIVER_PROTOCOL_VERSION = 'memeloop-peer-driver/v1';

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

    const result = await options.sendRpc(
      peerId,
      `${PEER_DRIVER_PROTOCOL_VERSION}/submit`,
      versionedAssignment,
    );

    return result as PeerDriverStatus;
  }

  async function getAssignmentStatus(
    peerId: string,
    assignmentId: string,
  ): Promise<PeerDriverStatus> {
    const result = await options.sendRpc(
      peerId,
      `${PEER_DRIVER_PROTOCOL_VERSION}/status`,
      { version: PEER_DRIVER_PROTOCOL_VERSION, assignmentId },
    );
    return result as PeerDriverStatus;
  }

  async function cancelAssignment(
    peerId: string,
    assignmentId: string,
  ): Promise<PeerDriverStatus> {
    const result = await options.sendRpc(
      peerId,
      `${PEER_DRIVER_PROTOCOL_VERSION}/cancel`,
      { version: PEER_DRIVER_PROTOCOL_VERSION, assignmentId },
    );
    return result as PeerDriverStatus;
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
  onSubmit?: (assignment: PeerDriverAssignment) => Promise<PeerDriverStatus>;
  onStatus?: (assignmentId: string) => Promise<PeerDriverStatus>;
  onCancel?: (assignmentId: string) => Promise<PeerDriverStatus>;
}): DeviceRpcHandler {
  return async (input) => {
    const { method, parameters } = input;

    if (method === `${PEER_DRIVER_PROTOCOL_VERSION}/submit`) {
      const assignment = parameters as PeerDriverAssignment;
      const version: string = assignment.version;
      if (version !== PEER_DRIVER_PROTOCOL_VERSION) {
        throw new Error('Unsupported peer driver protocol version: ' + version);
      }
      if (!handlers.onSubmit) {
        throw new Error('No submit handler registered');
      }
      return handlers.onSubmit(assignment);
    }

    if (method === `${PEER_DRIVER_PROTOCOL_VERSION}/status`) {
      const { assignmentId } = parameters as { assignmentId: string };
      if (!handlers.onStatus) {
        throw new Error('No status handler registered');
      }
      return handlers.onStatus(assignmentId);
    }

    if (method === `${PEER_DRIVER_PROTOCOL_VERSION}/cancel`) {
      const { assignmentId } = parameters as { assignmentId: string };
      if (!handlers.onCancel) {
        throw new Error('No cancel handler registered');
      }
      return handlers.onCancel(assignmentId);
    }

    throw new Error('Unknown peer driver protocol method: ' + method);
  };
}
