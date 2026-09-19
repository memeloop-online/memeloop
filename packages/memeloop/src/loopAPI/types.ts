/**
 * Unified loop contract for all agent loop types.
 * Replaces the old AgentToolLoopInput / AgentToolLoopStep naming entirely.
 */

import type { AgentModelConfig } from '../agent/types.js';
import type { AttachmentReference, ChatMessage, ChatMessagePart, DetailReference, ToolCall } from '../conversation/index.js';
import type { ResolvedAgentModelRoute } from '../llm/prepareModelRequest.js';
import type { AgentOrchestrationClient, ScriptDeploymentClientConfig } from '../orchestration/index.js';
import type { ScriptTrustClass } from '../orchestration/scripts/scriptAdmission.js';
import type { AgentFrameworkConfig } from '../promptUtilities/types.js';
// ─── Loop Input ────────────────────────────────────────────────────────

/** User-root payload waiting for the local event store to allocate causal identity. */
export interface PendingLocalChatMessage {
  messageId?: string;
  turnId?: string;
  originNodeId?: string;
  timestamp?: number;
  content?: string;
  parts?: ChatMessagePart[];
  toolCalls?: ToolCall[];
  attachments?: AttachmentReference[];
  detailRef?: DetailReference;
  reasoning_content?: string;
  contentType?: string;
  hidden?: boolean;
  duration?: number | null;
  metadata?: Record<string, unknown>;
}

/** Standard input for any agent loop. */
export interface AgentLoopInput {
  conversationId: string;
  message: string;
  /** Runtime-assigned identity used for per-run status and cancellation. */
  runId?: string;
  /** Aborted when durable run cancellation wins its lifecycle CAS. */
  signal?: AbortSignal;
  /** Exact model route frozen before the durable runtime accepts this run. */
  modelRoute?: ResolvedAgentModelRoute;
  /** Host-prepared user message, used when the platform needs metadata/attachments on the turn root. */
  userMessage?: PendingLocalChatMessage;
  /**
   * Canonical user turn already committed by the durable runtime. This is an
   * internal handoff: interactive hosts should pass `userMessage` and let the
   * target event store allocate its causal identity.
   */
  persistedUserMessage?: ChatMessage;
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
  checkpointAccepted?: boolean;
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

/** Disposes capabilities owned by one plugin installation. */
export type LoopPluginDisposer = () => void;

/** Capability extension point for a loop. */
export interface LoopPlugin {
  /** Unique plugin id, e.g. "fullReplacement" or "wikiTools". */
  id: string;
  /** Which loop id this plugin targets, or "*" for all loops. */
  targetLoopId?: string;
  /** Optional schema to validate against profile config. */
  schema?: Record<string, unknown>;
  /** Runtime capabilities are installed once; profile capabilities are composed per runner. */
  activationScope?: 'runtime' | 'profile';
  /** Tool capabilities made visible when a profile selects this plugin. */
  providedToolIds?: readonly string[];
  /** Install into the supplied scope and optionally return an owned disposer. */
  install?: (
    context: { [key: string]: unknown },
    config?: Record<string, unknown>,
  ) => LoopPluginDisposer | undefined;
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
  /** Structured reference to the loop script. */
  scriptReference?: LoopProfileScriptReference;
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
  modelConfig?: AgentModelConfig;
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

/** Canonical script checkpoint protocol identity shared by every host. */
export const LOOP_CHECKPOINT_API_VERSION = 'loops.memeloop.io/v1alpha1';
export const LOOP_CHECKPOINT_SCHEMA_VERSION = '1';

/**
 * A stable checkpoint declaration exported by a loop `.mjs` module.
 *
 * The loader combines this declaration with the canonical source digest and
 * the active profile version before a runtime can restore durable state.  A
 * script therefore owns the meaning of its state, while the host owns the
 * immutable identity that makes a hand-off safe.
 */
export interface LoopScriptCheckpointDeclaration {
  /** Stable logical name. Keep this unchanged when migrating a checkpoint. */
  id: string;
  /** Script-owned state schema/version. */
  version: string;
  /**
   * Explicitly converts a checkpoint from an older script/profile/digest
   * identity. Omit it to reject an incompatible checkpoint rather than
   * replaying it under new code.
   */
  migrate?: (checkpoint: LoopScriptCheckpoint) => unknown;
}

/** Full immutable identity attached to an accepted script checkpoint. */
export interface LoopScriptCheckpointIdentity {
  id: string;
  scriptVersion: string;
  /** Stable profile identity; profiles can share both a source digest and version. */
  profileId: string;
  profileVersion: string;
  scriptDigest: string;
  apiVersion: string;
  schemaVersion: string;
  /** The durable run is part of the hand-off boundary, never process-local. */
  runId?: string;
}

/** A checkpoint accepted by the durable store and available for recovery. */
export interface LoopScriptCheckpoint<T = unknown> {
  identity: LoopScriptCheckpointIdentity;
  key: string;
  result: T;
  revision: number;
  acceptedAt: number;
}

/** Runtime-only binding installed after a loader has admitted a script. */
export interface LoopScriptCheckpointBinding {
  identity: LoopScriptCheckpointIdentity;
  accepted: boolean;
  migrate?: LoopScriptCheckpointDeclaration['migrate'];
}

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
    /** Caller-owned cancellation/deadline signal for this child execution. */
    signal?: AbortSignal;
    /** Optional durable run identity used for cancellation bookkeeping. */
    runId?: string;
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
  /**
   * Internal runner hook that binds a loaded `.mjs` declaration to this
   * runtime. It is optional so embedders can expose a deliberately reduced
   * runtime, but Core only restores checkpoints after this binding succeeds.
   */
  bindScriptCheckpoint?: (binding: LoopScriptCheckpointBinding) => void;
  /** Emit a progress step upstream. */
  emit: (step: AgentLoopStep) => void;
  /** Signal whether the run has been cancelled. */
  signal: { cancelled: boolean };
}

/**
 * Immutable identity of the script checkpoint namespace.  A checkpoint from
 * another script/API/schema must never be visible to a resumed run.
 */
export interface LoopCheckpointScope {
  scriptDigest: string;
  apiVersion: string;
  schemaVersion: string;
  /** Stable logical checkpoint name, when a script declaration is active. */
  checkpointId?: string;
  /** Script-owned checkpoint schema version, when a declaration is active. */
  scriptVersion?: string;
  /** Active profile version frozen into the checkpoint namespace. */
  profileVersion?: string;
  /** Active profile identity frozen into the checkpoint namespace. */
  profileId?: string;
  /** Optional run identity used by hosts that share a conversation. */
  runId?: string;
  /** Runtime execution fence. This guards writes but is not part of the key. */
  fencingEpoch?: number;
}

export interface LoopCheckpointWriteOptions {
  scope?: LoopCheckpointScope;
  /** Revision observed by the caller.  Mismatches must fail closed. */
  expectedRevision?: number;
  /** Monotonic writer epoch.  Older writers must be rejected. */
  fencingEpoch?: number;
}

export interface LoopCheckpointRecord<T = unknown> {
  result: T;
  revision: number;
  fencingEpoch: number;
  scope?: LoopCheckpointScope;
}

/** Canonical key namespace shared by Core, CLI, and Desktop checkpoint stores. */
export function scopedLoopCheckpointKey(key: string, scope?: LoopCheckpointScope): string {
  if (!scope) return key;
  const encode = (value: string): string => encodeURIComponent(value);
  return `__memeloop_scope__:${encode(scope.scriptDigest)}:${encode(scope.apiVersion)}:${encode(scope.schemaVersion)}:${encode(scope.checkpointId ?? '')}:${
    encode(scope.scriptVersion ?? '')
  }:${encode(scope.profileId ?? '')}:${encode(scope.profileVersion ?? '')}:${encode(scope.runId ?? '')}:${encode(key)}`;
}

export interface LoopScriptCheckpointStore {
  /**
   * Persist replicated script state. Device hosts must append a canonical
   * `ConversationLoopCheckpointEvent` and read its deterministic LWW
   * projection so restart and cross-device hand-off observe the same value.
   */
  saveCheckpoint(
    conversationId: string,
    key: string,
    result: unknown,
    options?: LoopCheckpointWriteOptions,
  ): Promise<void>;
  loadCheckpoint<T>(conversationId: string, key: string, options?: { scope?: LoopCheckpointScope }): Promise<T | undefined>;
  /** Read the value and its CAS/fencing metadata atomically when available. */
  loadCheckpointRecord?<T>(
    conversationId: string,
    key: string,
    options?: { scope?: LoopCheckpointScope },
  ): Promise<LoopCheckpointRecord<T> | undefined>;
  /** Typed compare-and-set mutation.  Implementations must reject stale writers. */
  compareAndSetCheckpoint?<T>(
    conversationId: string,
    key: string,
    expectedRevision: number | undefined,
    result: T,
    options?: Omit<LoopCheckpointWriteOptions, 'expectedRevision'>,
  ): Promise<LoopCheckpointRecord<T>>;
}
