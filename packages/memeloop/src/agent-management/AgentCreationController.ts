/**
 * AgentCreationController — headless controller for the "Create New Agent" wizard.
 *
 * Manages creation wizard state: current step, template selection, temporary
 * agent definition lifecycle, and preview agent setup.
 *
 * No React, DOM, Electron, MUI, Zustand, or RxJS dependency.
 */

import type { AgentDefinition } from "../agent/types.js";
import type {
  AgentCreationState,
  AgentDefinitionRepository,
  AgentInstanceClient,
} from "./types.js";

/** Listener for creation state changes. */
export type CreationStateListener = (state: AgentCreationState) => void;

/** Options for creating an AgentCreationController. */
export interface AgentCreationControllerOptions {
  definitionRepository: AgentDefinitionRepository;
  agentInstanceClient: AgentInstanceClient;
  /** Default framework ID for new agents. */
  defaultFrameworkId?: string;
}

/**
 * Headless controller for the agent creation wizard.
 *
 * Call {@link start}, {@link selectTemplate}, {@link nextStep}, etc. to drive
 * the wizard. Subscribe via {@link subscribe} for state updates.
 */
export class AgentCreationController {
  private readonly options: Required<AgentCreationControllerOptions>;
  private listener: CreationStateListener | null = null;
  private state: AgentCreationState = {
    currentStep: 0,
    agentName: "",
    selectedTemplate: null,
    temporaryAgentDefinition: null,
    previewAgentId: null,
    isLoading: false,
    promptSchema: null,
  };

  constructor(options: AgentCreationControllerOptions) {
    this.options = {
      defaultFrameworkId: "memeloopTaskAgent",
      ...options,
    };
  }

  /** Initialize the creation wizard, optionally from a saved tab state. */
  async start(definitionId?: string, templateDefinitionId?: string): Promise<void> {
    this.emit({ isLoading: true });

    try {
      if (definitionId) {
        // Restore existing temporary definition
        const temporaryDefinition = await this.options.definitionRepository.getAgentDef(definitionId);
        if (temporaryDefinition) {
          this.state = {
            ...this.state,
            temporaryAgentDefinition: temporaryDefinition,
            agentName: temporaryDefinition.name ?? "",
            isLoading: false,
          };
          this.emit(this.state);
          // Load template if available
          if (templateDefinitionId) {
            const template = await this.options.definitionRepository.getAgentDef(templateDefinitionId);
            if (template) {
              this.state = { ...this.state, selectedTemplate: template };
              this.emit(this.state);
            }
          }
          return;
        }
      }

      this.emit({ isLoading: false });
    } catch {
      this.emit({ isLoading: false });
    }
  }

  /** Select a template for the new agent. */
  selectTemplate(template: AgentDefinition): void {
    this.state = { ...this.state, selectedTemplate: template };
    this.emit(this.state);
  }

  /** Update the agent name. */
  setAgentName(name: string): void {
    this.state = { ...this.state, agentName: name };
    this.emit(this.state);
  }

  /** Advance to the next wizard step. */
  nextStep(): void {
    this.state = { ...this.state, currentStep: Math.min(this.state.currentStep + 1, 2) };
    this.emit(this.state);
  }

  /** Go back to the previous wizard step. */
  previousStep(): void {
    this.state = { ...this.state, currentStep: Math.max(this.state.currentStep - 1, 0) };
    this.emit(this.state);
  }

  /** Set the current wizard step directly. */
  setStep(step: number): void {
    this.state = { ...this.state, currentStep: Math.max(0, Math.min(step, 2)) };
    this.emit(this.state);
  }

  /** Update the temporary agent definition. */
  updateTemporaryDefinition(change: Partial<AgentDefinition>): void {
    const updated = this.state.temporaryAgentDefinition
      ? { ...this.state.temporaryAgentDefinition, ...change }
      : null;
    this.state = { ...this.state, temporaryAgentDefinition: updated };
    this.emit(this.state);
  }

  /** Set the prompt schema for the selected framework. */
  setPromptSchema(schema: Record<string, unknown> | null): void {
    this.state = { ...this.state, promptSchema: schema };
    this.emit(this.state);
  }

  /**
   * Create a preview agent instance for the chat-preview step.
   * Should be called when entering step 2 (or the chat preview step).
   */
  async createPreviewAgent(definitionId: string): Promise<void> {
    this.emit({ isLoading: true });
    try {
      const result = await this.options.agentInstanceClient.createAgent(definitionId, {
        preview: true,
      });
      this.state = { ...this.state, previewAgentId: result.id, isLoading: false };
      this.emit(this.state);
    } catch {
      this.emit({ isLoading: false });
    }
  }

  /**
   * Finalize creation: persist the temporary definition and create the actual
   * agent instance. Returns the final agent instance ID, or null on failure.
   */
  async finalize(): Promise<string | null> {
    if (!this.state.temporaryAgentDefinition) return null;
    try {
      const definition = await this.options.definitionRepository.createAgentDef(
        this.state.temporaryAgentDefinition,
      );
      const instance = await this.options.agentInstanceClient.createAgent(definition.id);
      return instance.id;
    } catch {
      return null;
    }
  }

  /** Clean up temporary resources. */
  async cleanup(): Promise<void> {
    if (this.state.previewAgentId) {
      try {
        await this.options.agentInstanceClient.deleteAgent(this.state.previewAgentId);
      } catch {
        // Best-effort cleanup
      }
    }
  }

  // ── Subscription ──────────────────────────────────────────────

  subscribe(listener: CreationStateListener): () => void {
    this.listener = listener;
    listener({ ...this.state });
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  getState(): AgentCreationState {
    return this.state;
  }

  // ── Private ───────────────────────────────────────────────────

  private emit(change: AgentCreationState | Partial<AgentCreationState>): void {
    this.state = { ...this.state, ...change };
    this.listener?.({ ...this.state });
  }
}
