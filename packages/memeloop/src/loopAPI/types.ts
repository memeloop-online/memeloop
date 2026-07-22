/**
 * Unified loop contract for all agent loop types.
 * Replaces the old AgentToolLoopInput / AgentToolLoopStep naming entirely.
 */

import type { AiAPIConfig } from '../agent/types.js';
import type { ChatMessage } from '../conversation/index.js';
import type { AgentOrchestrationClient, ScriptDeploymentClientConfig } from '../orchestration/index.js';
import type { ScriptTrustClass } from '../orchestration/scripts/scriptAdmission.js';
import type { AgentFrameworkConfig } from '../promptUtilities/types.js';
// ─── Loop Input ────────────────────────────────────────────────────────

/** Standard input for any agent loop. */
export interface AgentLoopInput {
  conversationId: string;
  message: string;
  /** Host-prepared user message, used when the platform needs metadata/attachments on the turn root. */
  userMessage?: Omit<Partial<ChatMessage>, 'conversationId' | 'role'> & { content?: string };
  /** If provided, these messages are loaded as conversation history on resume. */
  resumeSession?: ChatMessage[];
}

// ─── Loop Step ──────────────────────────────────────────────────────────

/** Standard output step yielded by any agent loop. */
export interface AgentLoopStep {
  type: 'thinking' | 'tool' | 'message' | 'permission_request';
  data: unknown;
}

/** Async iterable signature shared by all loop runners. */
export type AgentLoopGenerator = AsyncIterable<AgentLoopStep>;

// ─── Loop Definition ──────────────────────────────────────────────────

/** Describes a registered loop type. */
export interface AgentLoopDefinition {
  /** Unique id, e.g. "agent-tool-loop" or "agent-agent-loop". */
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

// ─── Loop Script Reference ────────────────────────────────────────────

export type LoopProfileScriptReference =
  | { kind: 'builtin'; id: string }
  | { kind: 'specifier'; specifier: string }
  | { kind: 'source'; source: string; name?: string };

// ─── Script Load Gate (plan 24.15–24.19) ───────────────────────────────

/**
 * Request handed to a {@link ScriptLoadGate} before a data-URL/source script
 * is imported into the current process. The source has already been
 * normalized; the digest commits to the normalized form (plan 24.16).
 */
export interface ScriptLoadGateRequest {
  /** Normalized script source (`normalizeScript` output). */
  normalizedSource: string;
  /** Canonical SHA-256 hex digest of the normalized source. */
  digest: string;
  /** The original script reference being loaded. */
  reference: LoopProfileScriptReference;
  /** Script type label for diagnostics (e.g. "AgentAgentLoop script"). */
  scriptType: string;
}

/** Admission decision returned by a {@link ScriptLoadGate}. */
export interface ScriptLoadGateDecision {
  /** Whether the script may be imported into this process. */
  allowed: boolean;
  /** Human-readable denial reason (required when `allowed` is false). */
  reason?: string;
  /** Trust class assigned by admission (plan 24.17). */
  trustClass?: ScriptTrustClass;
  /** RuntimeClass name selected for the script (plan 24.18). */
  runtimeClass?: string;
  /** Whether the script may resume its expected checkpoint (plan 24.19). */
  checkpointCompatible?: boolean;
}

/**
 * Port: host-injected admission gate for script loading. Every non-builtin
 * script source must pass this gate before `import()`; when no gate is
 * configured the loader fails closed (denies all non-builtin sources).
 */
export interface ScriptLoadGate {
  admitScriptLoad(request: ScriptLoadGateRequest): Promise<ScriptLoadGateDecision> | ScriptLoadGateDecision;
}

export interface AgentLoopScriptPolicy {
  allowBuiltin?: boolean;
  allowFile?: boolean;
  allowNetwork?: boolean;
  allowSource?: boolean;
  allowSpecifier?: boolean;
  importModule?: (specifier: string) => Promise<unknown>;
  /**
   * Host-provided admission gate for non-builtin script sources. When
   * omitted, all non-builtin sources are denied (fail-closed).
   */
  scriptLoadGate?: ScriptLoadGate;
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
  /** Which loop to run. Defaults to "agent-tool-loop" if omitted. */
  loopId?: string;
  /** Structured reference to the loop script. Prefer this over `script` for new profiles. */
  scriptReference?: LoopProfileScriptReference;
  /** Legacy alias for `scriptReference`. */
  scriptRef?: LoopProfileScriptReference;
  /** Legacy path/specifier to the .mjs loop script. */
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
    default?: 'allow' | 'ask' | 'deny';
    rules?: Array<{ pattern: string; action: 'allow' | 'ask' | 'deny' }>;
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
  /** Policy-scoped declarative manager facade available to this loop. */
  orchestration?: AgentOrchestrationClient;
  /** Host-bound script deployment configuration used to build `ctx.scriptClient` (plan 24.14). */
  scriptDeployment?: ScriptDeploymentClientConfig;
  /** Run a child agent (or sub-loop) and return its result. */
  runChildAgent: (input: {
    profileId: string;
    prompt: string;
    conversationId: string;
  }) => AgentLoopGenerator;
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
  /** Load a previously completed step after process restart. */
  loadCheckpoint: <T>(key: string) => Promise<T | undefined>;
  /** Emit a progress step upstream. */
  emit: (step: AgentLoopStep) => void;
  /** Signal whether the run has been cancelled. */
  signal: { cancelled: boolean };
}

export interface LoopScriptCheckpointStore {
  saveCheckpoint(conversationId: string, key: string, result: unknown): Promise<void>;
  loadCheckpoint<T>(conversationId: string, key: string): Promise<T | undefined>;
}
