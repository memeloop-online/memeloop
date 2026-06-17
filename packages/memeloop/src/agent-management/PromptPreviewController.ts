/**
 * PromptPreviewController — headless controller for generating prompt previews.
 *
 * Manages preview dialog state, progress tracking, and result accumulation.
 *
 * No React, DOM, Electron, MUI, Zustand, or RxJS dependency.
 */

import type { ChatMessage } from '../conversation/index.js';
import type { AgentFrameworkConfig } from '../promptUtilities/types.js';
import type { PromptPreviewClient, PromptPreviewDialogState, PromptPreviewResult } from './types.js';

/** Listener for preview dialog state changes. */
export type PreviewDialogListener = (state: PromptPreviewDialogState) => void;

/** Options for creating a PromptPreviewController. */
export interface PromptPreviewControllerOptions {
  previewClient: PromptPreviewClient;
}

/**
 * Headless controller for the prompt preview/edit dialog.
 *
 * Call {@link open}, {@link close}, {@link generate} to drive the dialog.
 * Subscribe via {@link subscribe} for state updates.
 */
export class PromptPreviewController {
  private readonly options: PromptPreviewControllerOptions;
  private listener: PreviewDialogListener | null = null;
  private state: PromptPreviewDialogState = {
    open: false,
    baseMode: 'preview',
    activeTab: 'tree',
    loading: false,
    progress: 0,
    currentStep: '',
    currentPlugin: null,
    result: null,
    lastUpdated: null,
    formFieldsToScrollTo: [],
  };

  constructor(options: PromptPreviewControllerOptions) {
    this.options = options;
  }

  /** Open the dialog with an optional base mode. */
  open(baseMode?: 'preview' | 'edit'): void {
    this.state = {
      ...this.state,
      open: true,
      baseMode: baseMode ?? 'preview',
      loading: false,
      progress: 0,
      currentStep: 'Starting...',
      currentPlugin: null,
      result: null,
      lastUpdated: null,
      formFieldsToScrollTo: [],
    };
    this.emit();
  }

  /** Close the dialog. */
  close(): void {
    this.state = {
      ...this.state,
      open: false,
      baseMode: 'preview',
      lastUpdated: null,
      formFieldsToScrollTo: [],
    };
    this.emit();
  }

  /** Set the active tab in the dialog. */
  setActiveTab(tab: 'flat' | 'tree'): void {
    this.state = { ...this.state, activeTab: tab };
    this.emit();
  }

  /** Set form fields to scroll to (for edit mode navigation). */
  setFormFieldsToScrollTo(fieldPaths: string[]): void {
    this.state = { ...this.state, formFieldsToScrollTo: fieldPaths };
    this.emit();
  }

  /**
   * Generate a preview of the prompt tree.
   * @param agentFrameworkConfig  The agent's framework configuration
   * @param messages              Current conversation messages
   * @param inputText             Optional input text to include in the preview
   */
  async generate(
    agentFrameworkConfig: AgentFrameworkConfig,
    messages: ChatMessage[],
    inputText?: string,
  ): Promise<PromptPreviewResult | null> {
    this.state = {
      ...this.state,
      loading: true,
      progress: 0,
      currentStep: 'Preparing...',
    };
    this.emit();

    try {
      const result = await this.options.previewClient.generatePreview(
        agentFrameworkConfig,
        messages,
        inputText,
        (progress) => {
          this.state = {
            ...this.state,
            progress: progress.progress,
            currentStep: progress.step,
            currentPlugin: progress.currentPlugin ?? null,
          };
          this.emit();
        },
      );

      this.state = {
        ...this.state,
        loading: false,
        progress: 1,
        currentStep: 'Complete',
        currentPlugin: null,
        result,
        lastUpdated: new Date(),
      };
      this.emit();
      return result;
    } catch (_error) {
      this.state = {
        ...this.state,
        loading: false,
        progress: 0,
        currentStep: 'Error occurred',
        currentPlugin: null,
        result: null,
      };
      this.emit();
      return null;
    }
  }

  // ── Subscription ──────────────────────────────────────────────

  subscribe(listener: PreviewDialogListener): () => void {
    this.listener = listener;
    listener({ ...this.state });
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  getState(): PromptPreviewDialogState {
    return this.state;
  }

  // ── Private ───────────────────────────────────────────────────

  private emit(): void {
    this.listener?.({ ...this.state });
  }
}
