export { createFetchOrchestrationTransport, createRemoteOrchestrationClient, OrchestrationError, REMOTE_ORCHESTRATION_PROTOCOL } from 'memeloop';
export type {
  AgentDefinition,
  AgentOrchestrationCapabilities,
  AgentOrchestrationClient,
  AttachmentReference,
  ChatMessage,
  ConversationMeta,
  Device,
  DeviceCapabilities,
  DevicePlatform,
  DeviceReachability,
  DeviceTrustMode,
  MemeLoopProtocol,
  OrchestrationResource,
  OrchestrationResourceList,
  OrchestrationResourceQuery,
  OrchestrationResourceReference,
  RemoteOrchestrationRequest,
  RemoteOrchestrationResponse,
  RemoteOrchestrationTransport,
  RemoteOrchestrationTransportOptions,
  TrustedDeviceRecord,
} from 'memeloop';

import type {
  AgentOrchestrationCapabilities,
  AgentOrchestrationOperation,
  OrchestrationResource,
  OrchestrationResourceList,
  OrchestrationResourceQuery,
  OrchestrationResourceReference,
} from 'memeloop';

/**
 * Advisory cache boundary for IndexedDB/native implementations. It never
 * grants controller authority and must not be treated as current without a
 * matching remote resourceVersion.
 */
export interface PortableResourceCache {
  get(reference: OrchestrationResourceReference): Promise<OrchestrationResource | null>;
  list(query: OrchestrationResourceQuery): Promise<OrchestrationResourceList>;
  put(resource: OrchestrationResource): Promise<void>;
  remove(reference: OrchestrationResourceReference): Promise<void>;
  clear(): Promise<void>;
}

/** Honest capability advertisement for low-power/mobile remote-only hosts. */
export function createRemoteOnlyHostCapabilities(options: {
  resourceKinds: string[];
  writable?: boolean;
}): AgentOrchestrationCapabilities {
  const operations: AgentOrchestrationOperation[] = options.writable
    ? ['apply', 'get', 'list', 'watch', 'delete']
    : ['get', 'list', 'watch'];
  return {
    operations,
    resourceKinds: [...new Set(options.resourceKinds)],
    interfaces: ['resource'],
  };
}

export * from './indexedDatabaseResourceCache.js';
export * from './tauriOrchestrationTransport.js';
