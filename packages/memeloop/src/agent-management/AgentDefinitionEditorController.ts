/**
 * AgentDefinitionEditorController — headless controller for editing an agent definition.
 *
 * Manages definition loading, autosave, schema loading, preview agent lifecycle,
 * and scheduled task CRUD.
 *
 * No React, DOM, Electron, MUI, Zustand, or RxJS dependency.
 */

import type { AgentDefinition } from '../agent/types.js';
import type { AgentDefinitionEditorState, AgentDefinitionRepository, AgentInstanceClient, CreateScheduledTaskInput, ScheduledTask, ScheduledTaskClient } from './types.js';

/** Partial state emitted to the listener. */
export type EditorStateChange = Partial<AgentDefinitionEditorState>;

/** Listener for editor state changes. */
export type EditorStateListener = (change: EditorStateChange) => void;

/** Schedule editor sub-state for the UI layer. */
export interface ScheduleEditorState {
  mode: 'none' | 'interval' | 'daily' | 'cron';
  intervalValue: number;
  intervalUnit: 's' | 'min' | 'h';
  dailyTime: string;
  activeHoursStart: string;
  activeHoursEnd: string;
  cronExpression: string;
  timezone: string;
  message: string;
  existingTaskId?: string;
}

/** Options for creating an AgentDefinitionEditorController. */
export interface AgentDefinitionEditorControllerOptions {
  definitionRepository: AgentDefinitionRepository;
  agentInstanceClient: AgentInstanceClient;
  scheduledTaskClient: ScheduledTaskClient;
  /** Debounce interval for autosave in ms. Default 1000. */
  autosaveDebounceMs?: number;
}

/**
 * Headless controller for editing an agent definition.
 *
 * Call {@link loadDefinition} to start, then {@link subscribe} for state updates.
 */
export class AgentDefinitionEditorController {
  private readonly options: Required<AgentDefinitionEditorControllerOptions>;
  private listener: EditorStateListener | null = null;
  private state: AgentDefinitionEditorState = {
    agentDefinition: null,
    agentName: '',
    previewAgentId: null,
    isLoading: false,
    isSaving: false,
    promptSchema: null,
  };
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: AgentDefinitionEditorControllerOptions) {
    this.options = {
      autosaveDebounceMs: 1_000,
      ...options,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  /** Load an agent definition and its prompt schema. */
  async loadDefinition(definitionId: string): Promise<void> {
    this.emit({ isLoading: true });

    try {
      const [definition, previewAgentId] = await Promise.all([
        this.options.definitionRepository.getAgentDef(definitionId),
        this.findOrCreatePreviewAgent(definitionId),
      ]);

      if (!definition) {
        this.emit({ isLoading: false });
        return;
      }

      let promptSchema: Record<string, unknown> | null = null;
      if (definition.agentFrameworkID) {
        try {
          promptSchema = await this.options.agentInstanceClient.getFrameworkConfigSchema(
            definition.agentFrameworkID,
          );
        } catch {
          promptSchema = null;
        }
      }

      this.state = {
        agentDefinition: definition,
        agentName: definition.name ?? '',
        previewAgentId,
        isLoading: false,
        isSaving: false,
        promptSchema,
      };
      this.emit(this.state);
    } catch (_error) {
      this.emit({ isLoading: false });
    }
  }

  /** Update the agent definition field. Triggers debounced autosave. */
  updateDefinition(change: Partial<AgentDefinition> & { id: string }): void {
    if (!this.state.agentDefinition) return;
    const updated = { ...this.state.agentDefinition, ...change };
    this.state = { ...this.state, agentDefinition: updated, agentName: updated.name ?? '' };
    this.emit({ agentDefinition: updated, agentName: this.state.agentName });
    this.scheduleAutosave(updated);
  }

  /** Force an immediate save to the repository. */
  async saveNow(): Promise<void> {
    if (!this.state.agentDefinition) return;
    this.emit({ isSaving: true });
    try {
      await this.options.definitionRepository.updateAgentDef({
        id: this.state.agentDefinition.id,
        name: this.state.agentName,
        description: this.state.agentDefinition.description,
        agentFrameworkConfig: this.state.agentDefinition.agentFrameworkConfig,
        aiApiConfig: this.state.agentDefinition.aiApiConfig,
        agentTools: this.state.agentDefinition.agentTools,
        heartbeat: this.state.agentDefinition.heartbeat,
      });
    } catch (_error) {
      // Host should surface errors via its UI layer
    } finally {
      this.emit({ isSaving: false });
    }
  }

  /** Reload the prompt schema for a framework ID. */
  async reloadSchema(frameworkId: string): Promise<void> {
    try {
      const schema = await this.options.agentInstanceClient.getFrameworkConfigSchema(frameworkId);
      this.emit({ promptSchema: schema });
    } catch (_error) {
      this.emit({ promptSchema: null });
    }
  }

  // ── Preview agent lifecycle ───────────────────────────────────

  /** Get or create a preview agent instance tied to this definition. */
  private async findOrCreatePreviewAgent(definitionId: string): Promise<string | null> {
    try {
      const result = await this.options.agentInstanceClient.createAgent(definitionId, {
        preview: true,
      });
      return result.id;
    } catch (_error) {
      return null;
    }
  }

  // ── Scheduled tasks ───────────────────────────────────────────

  async loadScheduledTasks(): Promise<ScheduledTask[]> {
    if (!this.state.previewAgentId) return [];
    return this.options.scheduledTaskClient.listScheduledTasksForAgent(
      this.state.previewAgentId,
    );
  }

  async saveScheduledTask(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
    return this.options.scheduledTaskClient.createScheduledTask(input);
  }

  async deleteScheduledTask(taskId: string): Promise<void> {
    return this.options.scheduledTaskClient.deleteScheduledTask(taskId);
  }

  // ── Subscription ──────────────────────────────────────────────

  subscribe(listener: EditorStateListener): () => void {
    this.listener = listener;
    listener(this.state);
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  getState(): AgentDefinitionEditorState {
    return this.state;
  }

  // ── Private ───────────────────────────────────────────────────

  private emit(change: EditorStateChange): void {
    this.listener?.(change);
  }

  private scheduleAutosave(definition: AgentDefinition): void {
    if (this.autosaveTimer !== null) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      this.options.definitionRepository.updateAgentDef({
        id: definition.id,
        name: definition.name,
        description: definition.description,
        agentFrameworkConfig: definition.agentFrameworkConfig,
        aiApiConfig: definition.aiApiConfig,
        agentTools: definition.agentTools,
        heartbeat: definition.heartbeat,
      }).catch(() => {});
    }, this.options.autosaveDebounceMs);
  }
}
