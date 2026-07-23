export { createFetchOrchestrationTransport, createRemoteOrchestrationClient, OrchestrationError, REMOTE_ORCHESTRATION_PROTOCOL } from 'memeloop';
export type {
  AgentDefinition,
  AgentOrchestrationCapabilities,
  AgentOrchestrationClient,
  AttachmentReference,
  AttachmentReference as AttachmentRef,
  ChatMessage,
  ConversationMeta,
  OrchestrationResource,
  OrchestrationResourceList,
  OrchestrationResourceQuery,
  OrchestrationResourceReference,
  RemoteOrchestrationRequest,
  RemoteOrchestrationResponse,
  RemoteOrchestrationTransport,
  RemoteOrchestrationTransportOptions,
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

/** Compatibility wire types used by Desktop peer-discovery renderers. */
export interface WikiInfo {
  wikiId: string;
  title?: string;
  pathHint?: string;
}

export interface NodeProtocolCapabilities {
  tools: string[];
  mcpServers: string[];
  hasWiki: boolean;
  agentLoop: boolean;
  imChannels: string[];
  wikis: WikiInfo[];
}

export interface NodeStatus {
  identity: {
    nodeId: string;
    name: string;
    type: 'desktop' | 'node' | 'mobile';
  };
  status: 'online' | 'offline' | 'unknown';
  capabilities: NodeProtocolCapabilities;
}

export interface KnownNodeEntry {
  nodeId: string;
  staticPublicKey: string;
  name?: string | null;
  firstSeen: number;
  lastConnected: number;
  trustSource: 'pin-pairing' | 'cloud-registry';
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
