/**
 * Headless agent management contracts.
 *
 * Environment-neutral interfaces for managing agent definitions, agent instances,
 * conversations, prompt previews, and scheduled tasks.
 *
 * Designed to be consumed by:
 * - Desktop (via Electron IPC adapters)
 * - Cloud (via REST API adapters)
 * - CLI (via Ink + local or remote adapters)
 */

import type { AgentDefinition } from '../agent/types.js';
import type { ChatMessage } from '../conversation/index.js';
import type { AgentFrameworkConfig } from '../promptUtilities/types.js';

// ─── Attachment types (host-neutral) ───────────────────────────────

/** Attachment metadata for a wiki tiddler selected in the composer. */
export interface WikiTiddlerAttachment {
  workspaceName: string;
  tiddlerTitle: string;
}

/** Data passed when a wiki tiddler chip is clicked in a message. */
export interface WikiTiddlerClickData {
  workspaceId: string;
  workspaceName: string;
  tiddlerTitle: string;
  renderedContent?: string;
}

// ─── Agent Definition Repository ───────────────────────────────────

/** Storage contract for agent definition CRUD and template queries. */
export interface AgentDefinitionRepository {
  createAgentDef(agent: AgentDefinition): Promise<AgentDefinition>;
  updateAgentDef(agent: Partial<AgentDefinition> & { id: string }): Promise<AgentDefinition>;
  getAgentDefs(): Promise<AgentDefinition[]>;
  getAgentDef(id?: string): Promise<AgentDefinition | undefined>;
  getAgentTemplates(): Promise<AgentDefinition[]>;
  deleteAgentDef(id: string): Promise<void>;
}

// ─── Agent Instance Client ─────────────────────────────────────────

/** Observable agent runtime metadata exposed to the UI layer. */
export interface AgentRuntimeView {
  id: string;
  name: string;
  agentDefId: string;
  status: {
    state: 'idle' | 'working' | 'completed' | 'failed' | 'canceled' | 'input-required';
    progress?: string;
  };
  aiApiConfig?: AgentDefinition['aiApiConfig'];
  /** If applicable, the agent definition merged with instance overrides. */
  definition?: AgentDefinition;
}

/** Subscription callback for agent updates. */
export type AgentUpdateListener = (update: Partial<AgentRuntimeView>) => void;

/** Client contract for creating, controlling, and subscribing to agent instances. */
export interface AgentInstanceClient {
  /**
   * Create a new agent instance from a definition.
   * @param agentDefinitionId  The definition ID to instantiate from
   * @param options             Optional creation flags (e.g. { preview: true })
   */
  createAgent(agentDefinitionId: string, options?: { preview?: boolean }): Promise<{ id: string }>;

  /**
   * Fetch a full agent runtime view (messages excluded, available via conversation client).
   */
  fetchAgent(agentId: string): Promise<AgentRuntimeView>;

  /**
   * Update an agent instance with partial data.
   */
  updateAgent(agentId: string, data: Partial<AgentDefinition>): Promise<AgentRuntimeView>;

  /**
   * Cancel the current operation for an agent instance.
   */
  cancelAgent(agentId: string): Promise<void>;

  /**
   * Delete an agent instance and its associated conversation.
   */
  deleteAgent(agentId: string): Promise<void>;

  /**
   * Subscribe to live updates for an agent instance.
   * Returns an unsubscribe function.
   */
  subscribeToUpdates(agentId: string, listener: AgentUpdateListener): () => void;

  /**
   * Get the framework (handler) ID for an agent instance.
   */
  getAgentFrameworkId(agentId: string): Promise<string>;

  /**
   * Get the JSON Schema for the framework configuration.
   */
  getFrameworkConfigSchema(frameworkId: string): Promise<Record<string, unknown>>;
}

// ─── Agent Conversation Client ─────────────────────────────────────

/** Client contract for conversation operations on an agent instance. */
export interface AgentConversationClient {
  /** Load all messages for an agent's conversation. */
  getMessages(agentId: string): Promise<ChatMessage[]>;

  /** Send a user message to the agent. Returns the list of message IDs that were appended. */
  sendMessage(
    agentId: string,
    content: string,
    file?: File,
    wikiTiddlers?: WikiTiddlerAttachment[],
  ): Promise<void>;

  /** Subscribe to new message notifications. */
  subscribeToMessages(agentId: string, listener: (message: ChatMessage) => void): () => void;

  /** Delete an agent turn — removes the user message and all subsequent agent responses. */
  deleteTurn(userMessageId: string): Promise<string | undefined>;

  /** Retry an agent turn — delete agent responses and re-send the user message. */
  retryTurn(userMessageId: string): Promise<void>;
}

// ─── Prompt Preview Client ─────────────────────────────────────────

/** Progress callback for prompt preview generation. */
export interface PromptPreviewProgress {
  progress: number;
  step: string;
  currentPlugin?: string;
}

/** Result of a prompt preview generation. */
export interface PromptPreviewResult {
  flatPrompts: unknown[];
  processedPrompts: unknown[];
}

/** Client contract for generating prompt previews. */
export interface PromptPreviewClient {
  /**
   * Generate a preview of the prompt tree for the given agent state.
   * @param agentFrameworkConfig  The agent's framework configuration
   * @param messages              Current conversation messages
   * @param inputText             Optional input text to include in the preview
   * @param onProgress            Optional progress callback
   */
  generatePreview(
    agentFrameworkConfig: AgentFrameworkConfig,
    messages: ChatMessage[],
    inputText?: string,
    onProgress?: (progress: PromptPreviewProgress) => void,
  ): Promise<PromptPreviewResult | null>;
}

// ─── Scheduled Task Client ─────────────────────────────────────────

/** Scheduled task input. */
export interface CreateScheduledTaskInput {
  agentInstanceId: string;
  agentDefinitionId: string;
  name: string;
  scheduleKind: 'interval' | 'cron' | 'at';
  schedule: { kind: 'interval'; intervalSeconds: number } | { kind: 'cron'; expression: string; timezone?: string } | { kind: 'at'; wakeAtISO: string };
  payload?: { message: string };
  activeHoursStart?: string;
  activeHoursEnd?: string;
  createdBy?: string;
  enabled?: boolean;
}

/** Scheduled task model. */
export interface ScheduledTask {
  id: string;
  agentInstanceId: string;
  agentDefinitionId: string;
  name: string;
  schedule: CreateScheduledTaskInput['schedule'];
  payload?: { message?: string };
  activeHoursStart?: string;
  activeHoursEnd?: string;
  enabled: boolean;
  createdBy?: string;
}

/** Client contract for managing scheduled tasks. */
export interface ScheduledTaskClient {
  listScheduledTasksForAgent(agentInstanceId: string): Promise<ScheduledTask[]>;
  createScheduledTask(input: CreateScheduledTaskInput): Promise<ScheduledTask>;
  updateScheduledTask(id: string, input: Partial<CreateScheduledTaskInput>): Promise<ScheduledTask>;
  deleteScheduledTask(id: string): Promise<void>;
  getCronPreviewDates(expression: string, timezone?: string, count?: number): Promise<string[]>;
}

// ─── Agent Creation Wizard State ───────────────────────────────────

/** State for the "Create New Agent" wizard. */
export interface AgentCreationState {
  /** Current step index in the creation wizard. */
  currentStep: number;
  /** Agent name entered by the user. */
  agentName: string;
  /** Selected template definition, if any. */
  selectedTemplate: AgentDefinition | null;
  /** Temporary agent definition being built. */
  temporaryAgentDefinition: AgentDefinition | null;
  /** ID of the preview agent instance created for testing. */
  previewAgentId: string | null;
  /** Whether a loading operation is in progress. */
  isLoading: boolean;
  /** JSON Schema for the selected agent framework, if loaded. */
  promptSchema: Record<string, unknown> | null;
}

// ─── Agent Definition Editor State ─────────────────────────────────

/** State for the "Edit Agent Definition" view. */
export interface AgentDefinitionEditorState {
  /** The agent definition being edited. */
  agentDefinition: AgentDefinition | null;
  /** Agent name. */
  agentName: string;
  /** ID of the preview agent instance. */
  previewAgentId: string | null;
  /** Whether a loading operation is in progress. */
  isLoading: boolean;
  /** Whether a save operation is in progress. */
  isSaving: boolean;
  /** JSON Schema for the selected agent framework, if loaded. */
  promptSchema: Record<string, unknown> | null;
}

// ─── Prompt Preview State ──────────────────────────────────────────

/** State for the prompt preview/edit dialog. */
export interface PromptPreviewDialogState {
  open: boolean;
  baseMode: 'preview' | 'edit';
  activeTab: 'flat' | 'tree';
  loading: boolean;
  progress: number;
  currentStep: string;
  currentPlugin: string | null;
  result: PromptPreviewResult | null;
  lastUpdated: Date | null;
  formFieldsToScrollTo: string[];
}
