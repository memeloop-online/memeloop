// Loop API registry, types, and built-in loop definitions.
export * from './loopAPI/agent-agent-loop/index.js';
export * from './loopAPI/agent-tool-loop/index.js';
export * from './loopAPI/plugins/builtinLoopsPlugin.js';
export * from './loopAPI/plugins/index.js';
export * from './loopAPI/registry.js';
export { TokenTracker } from './loopAPI/tokenTracker.js';
export * from './loopAPI/types.js';
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
export * from './llm/fetchProvider.js';
export * from './llm/providerRegistry.js';

// Network utilities not tied to peer transport
export { gitProxyTargetBlockReason } from './network/gitProxyUrlPolicy.js';

// Device network abstraction (libp2p-first)
export * from './device-network/index.js';

// IM bridge types + implementation
export * from './im/index.js';

// Sync types
export * from './sync/protocol.js';

// Conversation message and attachment types
export * from './conversation/index.js';

export * from './loopAPI/hooks/registry.js';
export * from './loopAPI/hooks/types.js';
export * from './permission/index.js';
export * from './plugin/index.js';
export { registerBuiltinPromptPlugins } from './promptUtilities/builtinPromptPlugins.js';
export { findPromptById, flattenPrompts, promptConcatStream } from './promptUtilities/promptConcat.js';
export type { PromptConcatPluginPreview, PromptConcatStreamState } from './promptUtilities/promptConcat.js';
export * from './promptUtilities/responsePatternUtility.js';
export type { AgentFrameworkConfig, AgentPromptDescription, IPrompt, PromptNode, PromptPluginConfig } from './promptUtilities/types.js';
export * from './tools/index.js';
