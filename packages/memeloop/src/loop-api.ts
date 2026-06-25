/**
 * Loop API entry point — agent loops, profiles, and primitives.
 *
 * This module intentionally excludes libp2p device-network, IM bridge, Solid Pod
 * sync, and other Node.js-hostile subsystems so that React Native/Expo bundlers
 * (Metro) can import the agent loop runtime without tripping on native modules.
 *
 * For the full runtime (including device networking), import from 'memeloop'.
 */
export * from './loopAPI/agent-agent-loop/index.js';
export * from './loopAPI/agent-tool-loop/index.js';
export * from './loopAPI/hooks/registry.js';
export * from './loopAPI/hooks/types.js';
export * from './loopAPI/plugins/builtinLoopsPlugin.js';
export * from './loopAPI/plugins/index.js';
export * from './loopAPI/registry.js';
export { TokenTracker } from './loopAPI/tokenTracker.js';
export * from './loopAPI/types.js';
export * from './runtime.js';

// Profiles (now embedded at build time, no fs/path runtime deps)
export { getBuiltinLoopProfile, getBuiltinLoopProfiles, registerBuiltinLoopProfiles } from './loopProfiles/loadBuiltins.js';

// Agent definitions / categories (shared types, no runtime deps)
export * from './agent/agentProfileRegistry.js';
export * from './agent/agentProfiles.js';
export * from './agent/categories.js';
export * from './agent/types.js';

// Core runtime types (storage, LLM, tools, network — needed by host adapters)
export type {
  AgentFrameworkContext,
  AgentInstanceLatestStatus,
  AgentInstanceModel,
  AgentInstanceState,
  AgentToolLoopOptions,
  GetMessagesOptions,
  IAgentStorage,
  IChatSyncAdapter,
  ILLMProvider,
  INetworkService,
  IToolRegistry,
  ListConversationsOptions,
  MemeLoopLogger,
} from './types.js';
export type { AgentInstanceModel as AgentInstance } from './types.js';

// LLM provider registry
export * from './llm/providerRegistry.js';

// Conversation types
export * from './conversation/index.js';
export type { AttachmentReference, ChatMessage } from './conversation/types.js';

// Prompt utilities (used by tool plugins)
export { registerBuiltinPromptPlugins } from './promptUtilities/builtinPromptPlugins.js';
export { findPromptById, flattenPrompts, promptConcatStream } from './promptUtilities/promptConcat.js';
export type { PromptConcatPluginPreview, PromptConcatStreamState } from './promptUtilities/promptConcat.js';
export * from './promptUtilities/responsePatternUtility.js';

// Storage primitives
export { nextLamportClockForConversation } from './storage/nextLamport.js';

// Plugin infrastructure
export * from './permission/index.js';
export * from './plugin/index.js';
