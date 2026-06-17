// Loop registry, types, and the default LLM_IO_Loop
export * from './agentLoops/llm-io/index.js';
export * from './agentLoops/registry.js';
export { TokenTracker } from './agentLoops/tokenTracker.js';
export * from './agentLoops/types.js';
export * from './runtime.js';
export { decodeAttachmentBlobRpc } from './sync/attachmentRpcCodec.js';
export * from './sync/chatSyncEngine.js';
export * from './sync/peerNodeAdapter.js';
export * from './types.js';
// SolidPodSyncAdapter is intentionally NOT exported from the main entry to avoid
// pulling in @inrupt/solid-client (and its jsonld-streaming-parser dep) in environments
// that don't need Solid Pod sync. Import directly from 'memeloop/src/sync/solidPodAdapter.js'
// when needed (e.g. inside a worker thread that has the full dependency tree).
export { getBuiltinLoopProfile, getBuiltinLoopProfiles } from './loopProfiles/loadBuiltins.js';
export { SessionStorage } from './storage/sessionStorage.js';
export { createCheckpointRecord, parseCheckpointRecord, serializeCheckpointRecord } from './storage/sessionStorage.js';
export type { CheckpointRecord, CheckpointStore } from './storage/sessionStorage.js';

// Agent definition/profile types
export * from './agent/agentProfileRegistry.js';
export * from './agent/agentProfiles.js';
export * from './agent/categories.js';
export { tiddlerToAgentDefinition } from './agent/tiddlerTemplateConverter.js';
export type { TiddlerFieldsForAgent } from './agent/tiddlerTemplateConverter.js';
export * from './agent/types.js';
export type { AgentInstanceModel, AgentInstanceModel as AgentInstance } from './types.js';

// Headless agent management contracts (host-neutral interfaces for UI layer)
export * from './agent-management/index.js';

// LLM providers
export * from './llm/providerRegistry.js';

// Network: core protocol types + auth (noise transport is CLI-only; import from memeloop/src/network/noiseTransport.js)
export { buildAuthHandshakeMessage, parseAuthHandshakeMessage } from './network/authHandshake.js';
export type { ParsedHandshake } from './network/authHandshake.js';
export { ConnectivityManager, detectPublicIP, resolveConnectAddress } from './network/connectivity.js';
export type { ConnectivityState, FrpTunnelOptions, FrpTunnelStop } from './network/connectivity.js';
export { gitProxyTargetBlockReason } from './network/gitProxyUrlPolicy.js';
export { InMemoryKnownNodesRepository, KnownNodesService, parseKnownNodesFile, serializeKnownNodesFile } from './network/knownNodesStore.js';
export type { KnownNodesFile, KnownNodesRepository } from './network/knownNodesStore.js';
export { MEMELOOP_SERVICE_TYPE } from './network/lanDiscovery.js';
export type { LanDiscoveryBrowseOptions, LanDiscoveryRegisterOptions, MemeloopServiceInfo } from './network/lanDiscovery.js';
export { computePinConfirmCode, verifyPinConfirmCode } from './network/pinConfirmCode.js';
export { createPairingToken, generatePin, verifyPairingToken } from './network/pinPairing.js';

// IM bridge types + implementation
export * from './im/index.js';

// Sync types
export * from './sync/protocol.js';

// Conversation message and attachment types
export * from './conversation/index.js';

export * from './agentLoops/hooks/registry.js';
export * from './agentLoops/hooks/types.js';
export * from './permission/index.js';
export * from './plugin/index.js';
export { findPromptById, flattenPrompts, promptConcatStream } from './promptUtilities/promptConcat.js';
export type { PromptConcatPluginPreview, PromptConcatStreamState } from './promptUtilities/promptConcat.js';
export * from './promptUtilities/responsePatternUtility.js';
export type { AgentFrameworkConfig, AgentPromptDescription, IPrompt, PromptNode, PromptPluginConfig } from './promptUtilities/types.js';
export * from './tools/index.js';
