/**
 * PromptPreviewController — headless controller for generating prompt previews.
 *
 * Manages preview dialog state, progress tracking, and result accumulation.
 *
 * No React, DOM, Electron, MUI, Zustand, or RxJS dependency.
 */

import type { AgentFrameworkConfig } from '../promptUtilities/types.js';
import {
  assertPromptPreviewAuditDetailChunk,
  assertPromptPreviewAuditDetailRequest,
  assertPromptPreviewAuditPage,
  assertPromptPreviewAuditPageRequest,
  assertPromptPreviewGeneratedResult,
  assertPromptPreviewPreparedExecution,
  PromptPreviewAuditError,
} from './PromptPreviewAudit.js';
import type {
  PromptPreviewAuditDetailChunk,
  PromptPreviewAuditDetailRequest,
  PromptPreviewAuditPage,
  PromptPreviewAuditPageRequest,
  PromptPreviewClient,
  PromptPreviewDialogState,
  PromptPreviewPreparedExecution,
  PromptPreviewResult,
} from './types.js';

/** Listener for preview dialog state changes. */
export type PreviewDialogListener = (state: PromptPreviewDialogState) => void;

/** Options for creating a PromptPreviewController. */
export interface PromptPreviewControllerOptions {
  previewClient: PromptPreviewClient;
  /**
   * Atomically load persistent bounded context and prepare its exact model
   * request under one route fence. Hosts should delegate to
   * `prepareAgentExecutionModelRequest`.
   */
  prepareExecutionModelRequest(
    conversationId: string,
    agentFrameworkConfig: AgentFrameworkConfig,
    options: { inputText?: string; signal: AbortSignal },
  ): Promise<PromptPreviewPreparedExecution>;
}

export interface PromptPreviewAuditReadOptions {
  signal?: AbortSignal;
}

/**
 * Headless controller for the prompt preview/edit dialog.
 *
 * Call {@link open}, {@link close}, {@link generate} to drive the dialog.
 * Subscribe via {@link subscribe} for state updates.
 */
export class PromptPreviewController {
  private readonly options: PromptPreviewControllerOptions;
  private readonly listeners = new Set<PreviewDialogListener>();
  private generation = 0;
  private activeAbortController?: AbortController;
  private activeExecution?: PromptPreviewPreparedExecution;
  private state: PromptPreviewDialogState = {
    open: false,
    baseMode: 'preview',
    activeTab: 'tree',
    loading: false,
    progress: 0,
    currentStep: 'idle',
    currentStepDisplay: null,
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
    this.invalidateActiveSession('prompt preview reopened');
    this.state = {
      ...this.state,
      open: true,
      baseMode: baseMode ?? 'preview',
      loading: false,
      progress: 0,
      currentStep: 'starting',
      currentStepDisplay: null,
      currentPlugin: null,
      result: null,
      lastUpdated: null,
      formFieldsToScrollTo: [],
    };
    this.emit();
  }

  /** Close the dialog. */
  close(): void {
    this.invalidateActiveSession('prompt preview closed');
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
   * @param conversationId        Durable conversation identity. The controller
   *                              loads execution-equivalent context itself;
   *                              UI resident messages are never accepted.
   * @param inputText             Optional input text to include in the preview
   */
  async generate(
    agentFrameworkConfig: AgentFrameworkConfig,
    conversationId: string,
    inputText?: string,
  ): Promise<PromptPreviewResult | null> {
    const generation = ++this.generation;
    this.activeAbortController?.abort(new Error('prompt preview superseded'));
    this.releaseActiveAuditSession();
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    this.state = {
      ...this.state,
      loading: true,
      progress: 0,
      currentStep: 'preparing',
      currentStepDisplay: null,
    };
    this.emit();

    try {
      const execution = await this.options.prepareExecutionModelRequest(
        conversationId,
        agentFrameworkConfig,
        {
          ...(inputText === undefined ? {} : { inputText }),
          signal: abortController.signal,
        },
      );
      assertPromptPreviewPreparedExecution(execution);
      if (generation !== this.generation || abortController.signal.aborted) {
        this.releaseAuditSession(execution);
        return null;
      }
      this.activeExecution = execution;
      const result = await this.options.previewClient.generatePreview(
        agentFrameworkConfig,
        execution,
        (progress) => {
          if (generation !== this.generation || abortController.signal.aborted) return;
          this.state = {
            ...this.state,
            progress: progress.progress,
            currentStep: progress.stepCode,
            currentStepDisplay: boundedDisplayText(progress.stepDisplay),
            currentPlugin: boundedDisplayText(progress.currentPlugin),
          };
          this.emit();
        },
        { signal: abortController.signal },
      );
      if (generation !== this.generation || abortController.signal.aborted) return null;
      if (result === null) {
        this.releaseActiveAuditSession();
      } else {
        assertPromptPreviewGeneratedResult(result);
      }

      const resultWithAudit = result === null ? null : { ...result, audit: execution };

      this.state = {
        ...this.state,
        loading: false,
        progress: 1,
        currentStep: 'complete',
        currentStepDisplay: null,
        currentPlugin: null,
        result: resultWithAudit,
        lastUpdated: new Date(),
      };
      this.emit();
      return resultWithAudit;
    } catch {
      if (generation !== this.generation || abortController.signal.aborted) return null;
      this.releaseActiveAuditSession();
      this.state = {
        ...this.state,
        loading: false,
        progress: 0,
        currentStep: 'error',
        currentStepDisplay: null,
        currentPlugin: null,
        result: null,
      };
      this.emit();
      return null;
    }
  }

  /** Load one bounded message-navigation page for the active exact request. */
  async getAuditPage(
    request: PromptPreviewAuditPageRequest,
    options: PromptPreviewAuditReadOptions = {},
  ): Promise<PromptPreviewAuditPage> {
    assertPromptPreviewAuditPageRequest(request);
    const generation = this.assertActiveRequest(request.sessionId, request.expectedRevision);
    const linked = this.createReadSignal(options.signal);
    try {
      const page = await this.options.previewClient.getAuditPage(request, { signal: linked.signal });
      this.assertStillActive(generation, request.sessionId, request.expectedRevision);
      assertPromptPreviewAuditPage(page, {
        expectedSessionId: request.sessionId,
        expectedRevision: request.expectedRevision,
        maxBytes: request.maxBytes,
        maxEntries: request.limit,
      });
      return page;
    } catch (error) {
      if (!this.isStillActive(generation, request.sessionId, request.expectedRevision)) {
        throw new PromptPreviewAuditError('stale_revision', error);
      }
      throw error;
    } finally {
      linked.dispose();
    }
  }

  /** Load one bounded raw canonical UTF-8 chunk for an entry or the full request. */
  async getAuditDetail(
    request: PromptPreviewAuditDetailRequest,
    options: PromptPreviewAuditReadOptions = {},
  ): Promise<PromptPreviewAuditDetailChunk> {
    assertPromptPreviewAuditDetailRequest(request);
    const generation = this.assertActiveRequest(request.sessionId, request.expectedRevision);
    const linked = this.createReadSignal(options.signal);
    try {
      const chunk = await this.options.previewClient.getAuditDetail(request, { signal: linked.signal });
      this.assertStillActive(generation, request.sessionId, request.expectedRevision);
      assertPromptPreviewAuditDetailChunk(chunk, request);
      return chunk;
    } catch (error) {
      if (!this.isStillActive(generation, request.sessionId, request.expectedRevision)) {
        throw new PromptPreviewAuditError('stale_revision', error);
      }
      throw error;
    } finally {
      linked.dispose();
    }
  }

  // ── Subscription ──────────────────────────────────────────────

  subscribe(listener: PreviewDialogListener): () => void {
    this.listeners.add(listener);
    safelyNotify(listener, this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): PromptPreviewDialogState {
    return this.state;
  }

  // ── Private ───────────────────────────────────────────────────

  private emit(): void {
    for (const listener of this.listeners) safelyNotify(listener, this.state);
  }

  private assertActiveRequest(sessionId: string, revision: string): number {
    const active = this.activeExecution;
    if (
      active === undefined || active.sessionId !== sessionId || active.revision !== revision ||
      this.activeAbortController?.signal.aborted !== false
    ) throw new PromptPreviewAuditError('stale_revision');
    return this.generation;
  }

  private assertStillActive(generation: number, sessionId: string, revision: string): void {
    if (!this.isStillActive(generation, sessionId, revision)) {
      throw new PromptPreviewAuditError('stale_revision');
    }
  }

  private isStillActive(generation: number, sessionId: string, revision: string): boolean {
    const active = this.activeExecution;
    return generation === this.generation && active?.sessionId === sessionId &&
      active.revision === revision && this.activeAbortController?.signal.aborted === false;
  }

  private createReadSignal(externalSignal: AbortSignal | undefined): {
    signal: AbortSignal;
    dispose(): void;
  } {
    const activeSignal = this.activeAbortController?.signal;
    if (activeSignal === undefined || activeSignal.aborted) {
      throw new PromptPreviewAuditError('stale_revision');
    }
    const controller = new AbortController();
    const abort = (signal: AbortSignal) => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    };
    const onActiveAbort = () => {
      abort(activeSignal);
    };
    const onExternalAbort = () => {
      if (externalSignal !== undefined) abort(externalSignal);
    };
    activeSignal.addEventListener('abort', onActiveAbort, { once: true });
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    if (activeSignal.aborted) abort(activeSignal);
    if (externalSignal?.aborted === true) abort(externalSignal);
    return {
      signal: controller.signal,
      dispose: () => {
        activeSignal.removeEventListener('abort', onActiveAbort);
        externalSignal?.removeEventListener('abort', onExternalAbort);
      },
    };
  }

  private invalidateActiveSession(reason: string): void {
    this.generation += 1;
    this.activeAbortController?.abort(new Error(reason));
    this.activeAbortController = undefined;
    this.releaseActiveAuditSession();
  }

  private releaseActiveAuditSession(): void {
    const execution = this.activeExecution;
    this.activeExecution = undefined;
    if (execution !== undefined) this.releaseAuditSession(execution);
  }

  private releaseAuditSession(execution: PromptPreviewPreparedExecution): void {
    try {
      void Promise.resolve(this.options.previewClient.releaseAuditSession({
        sessionId: execution.sessionId,
        expectedRevision: execution.revision,
      })).catch(() => {
        // Release is idempotent/best-effort; stale host sessions must not break the UI.
      });
    } catch {
      // Isolate synchronous host adapter failures as well.
    }
  }
}

function boundedDisplayText(value: string | undefined): string | null {
  if (value === undefined) return null;
  let result = '';
  for (let index = 0; index < value.length && result.length < 256; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0x20 && codeUnit !== 0x7f) result += value[index];
  }
  return result || null;
}

function safelyNotify(listener: PreviewDialogListener, state: PromptPreviewDialogState): void {
  try {
    listener({ ...state });
  } catch {
    // Observers are isolated: a broken plugin view must not starve other views.
  }
}
