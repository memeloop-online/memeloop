/**
 * Unified loop contract for all agent loop types.
 * Replaces the old TaskAgentInput / TaskAgentStep naming entirely.
 */

import type { AiAPIConfig } from "../agent/types.js";
import type { ChatMessage } from "../conversation/index.js";
import type { AgentFrameworkConfig } from "../promptUtilities/types.js";
// ─── Loop Input ────────────────────────────────────────────────────────

/** Standard input for any agent loop. */
export interface AgentLoopInput {
  conversationId: string;
  message: string;
  /** Host-prepared user message, used when the platform needs metadata/attachments on the turn root. */
  userMessage?: Omit<Partial<ChatMessage>, "conversationId" | "role"> & { content?: string };
  /** If provided, these messages are loaded as conversation history on resume. */
  resumeSession?: ChatMessage[];
}

// ─── Loop Step ──────────────────────────────────────────────────────────

/** Standard output step yielded by any agent loop. */
export interface AgentLoopStep {
  type: "thinking" | "tool" | "message" | "permission_request";
  data: unknown;
}

/** Async iterable signature shared by all loop runners. */
export type AgentLoopGenerator = AsyncIterable<AgentLoopStep>;

// ─── Loop Definition ──────────────────────────────────────────────────

/** Describes a registered loop type. */
export interface AgentLoopDefinition {
  /** Unique id, e.g. "llm-io" or "sub-agent". */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Short description of this loop's behaviour. */
  description: string;
  /** Factory: create a loop runner function for the given context. */
  createRunner: (context: {
    [key: string]: unknown;
  }) => (input: AgentLoopInput) => AgentLoopGenerator;
}

// ─── Loop Plugin ────────────────────────────────────────────────────────

/** Capability extension point for a loop. */
export interface LoopPlugin {
  /** Unique plugin id, e.g. "fullReplacement" or "wikiTools". */
  id: string;
  /** Which loop id this plugin targets, or "*" for all loops. */
  targetLoopId?: string;
  /** Optional schema to validate against profile config. */
  schema?: Record<string, unknown>;
  /** Install the plugin into the given context. Mutates the context in place. */
  install?: (context: { [key: string]: unknown }, config?: Record<string, unknown>) => void;
}

// ─── Loop Profile ──────────────────────────────────────────────────────

/** A complete agent profile that describes which loop, which .mjs script, prompts, plugins, and hooks to use. */
export interface LoopProfile {
  /** Unique profile id, e.g. "memeloop:general-assistant". */
  id: string;
  /** Display name. */
  name: string;
  /** Description. */
  description: string;
  /** Which loop to run. Defaults to "llm-io" if omitted. */
  loopId?: string;
  /** Path (host-resolvable) to the .mjs loop script. */
  script?: string;
  /** System prompt (concise form; detailed prompts go to `prompts`). */
  systemPrompt?: string;
  /** Tool allowlist IDs. */
  tools?: string[];
  /** Agent-level tool configuration. */
  agentTools?: Array<{
    toolId: string;
    enabled?: boolean;
    parameters?: Record<string, unknown>;
    tags?: string[];
  }>;
  /** Full agent framework configuration. */
  agentFrameworkConfig?: AgentFrameworkConfig;
  /** System prompt(s) for the agent. */
  prompts?: LoopProfilePrompt[];
  /** Tool / prompt / response plugin configs. */
  plugins?: LoopProfilePluginEntry[];
  /** Hook plugin configs. */
  hookPlugins?: LoopProfilePluginEntry[];
  /** Model configuration. */
  modelConfig?: {
    provider?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };
  /** Host-specific AI API config override. */
  aiApiConfig?: AiAPIConfig;
  /** Periodic auto-wake configuration. */
  heartbeat?: {
    enabled: boolean;
    intervalSeconds: number;
    message: string;
    activeHoursStart?: string;
    activeHoursEnd?: string;
  };
  /** Host-specific handler / framework ID. */
  agentFrameworkID?: string;
  /** Host-specific avatar or icon URL. */
  avatarUrl?: string;
  /** Tool permission configuration. */
  permissions?: {
    default?: "allow" | "ask" | "deny";
    rules?: Array<{ pattern: string; action: "allow" | "ask" | "deny" }>;
    perAgent?: Record<
      string,
      { default?: string; rules?: Array<{ pattern: string; action: string }> }
    >;
  };
  /** Open schema for host-specific or loop-specific configuration. */
  schema?: Record<string, unknown>;
  /** Arbitrary metadata. */
  metadata?: Record<string, unknown>;
  /** Version string. */
  version?: string;
}

export interface LoopProfilePrompt {
  id: string;
  role: string;
  text: string;
  caption?: string;
  children?: LoopProfilePrompt[];
}

export interface LoopProfilePluginEntry {
  /** Plugin id registered in the plugin registry. */
  id: string;
  /** Whether this plugin is enabled. */
  enabled?: boolean;
  /** Plugin-specific configuration. */
  config?: Record<string, unknown>;
}

// ─── Loop Runtime Context ─────────────────────────────────────────────

/** Minimal runtime context passed to a loop runner. */
export interface AgentLoopRuntime {
  /** Resolve a profile by id. */
  resolveProfile: (profileId: string) => Promise<LoopProfile | null>;
  /** Run a child agent (or sub-loop) and return its result. */
  runChildAgent: (input: {
    profileId: string;
    prompt: string;
    conversationId: string;
  }) => AsyncGenerator<AgentLoopStep, void, unknown>;
  /** Log an event for observability. */
  log: (event: string, data?: Record<string, unknown>) => void;
  /** Read/write persistent state for this run. */
  state: {
    get: <T>(key: string) => Promise<T | undefined>;
    set: (key: string, value: unknown) => Promise<void>;
    update: (key: string, updater: (previous: unknown) => unknown) => Promise<void>;
  };
  /** Checkpoint a completed step so it can be skipped on resume. */
  checkpoint: (key: string, result: unknown) => Promise<void>;
  /** Emit a progress step upstream. */
  emit: (step: AgentLoopStep) => void;
  /** Signal whether the run has been cancelled. */
  signal: { cancelled: boolean };
}
