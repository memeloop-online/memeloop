import { createHash } from 'node:crypto';

import {
  type AgentOrchestrationClient,
  createDeviceOrchestrationStreamHandler,
  createNamespacedOrchestrationClient,
  createRemoteOrchestrationHandler,
  type DeviceOrchestrationStreamHandler,
} from 'memeloop';

const ORDINARY_PEER_RESOURCE_KINDS = [
  'AgentWorkload',
  'AgentRun',
  'ToolOperation',
] as const;
const ORDINARY_PEER_MUTABLE_RESOURCE_KINDS = [
  'AgentWorkload',
  'ToolOperation',
] as const;

/** Stable, non-reversible tenant namespace derived from the authenticated peer identity. */
export function ordinaryPeerNamespace(remotePeerId: string): string {
  const peerId = remotePeerId.trim();
  if (!peerId) throw new TypeError('remotePeerId must not be empty');
  return `peer-${createHash('sha256').update(peerId).digest('hex').slice(0, 32)}`;
}

/**
 * Expose declarative runtime/model/tool assignments to mutually trusted
 * ordinary peers. The Noise-authenticated peer identity selects the namespace;
 * no wire field can select a ControlStore actor, node, driver, or tenant.
 */
export function createOrdinaryPeerOrchestrationHandler(
  client: AgentOrchestrationClient,
): DeviceOrchestrationStreamHandler {
  return createDeviceOrchestrationStreamHandler({
    resolveHandler(remotePeerId) {
      return createRemoteOrchestrationHandler(
        createNamespacedOrchestrationClient(client, {
          namespace: ordinaryPeerNamespace(remotePeerId),
          allowedResourceKinds: ORDINARY_PEER_RESOURCE_KINDS,
          mutableResourceKinds: ORDINARY_PEER_MUTABLE_RESOURCE_KINDS,
        }),
      );
    },
  });
}
