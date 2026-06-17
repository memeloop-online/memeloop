/**
 * agent-management — headless agent management contracts and controllers.
 *
 * Environment-neutral interfaces and pure-TypeScript controllers for:
 * - Agent definition CRUD (AgentDefinitionRepository)
 * - Agent instance lifecycle (AgentInstanceClient)
 * - Conversation operations (AgentConversationClient)
 * - Prompt preview generation (PromptPreviewClient)
 * - Scheduled task management (ScheduledTaskClient)
 *
 * No React, DOM, Electron, MUI, Zustand, or RxJS dependency.
 */

// ── Types ──────────────────────────────────────────────────────────

export type {
  AgentCreationState,
  AgentDefinitionEditorState,
  AgentDefinitionRepository,
  AgentInstanceClient,
  AgentConversationClient,
  AgentRuntimeView,
  AgentUpdateListener,
  CreateScheduledTaskInput,
  PromptPreviewClient,
  PromptPreviewDialogState,
  PromptPreviewProgress,
  PromptPreviewResult,
  ScheduledTask,
  ScheduledTaskClient,
  WikiTiddlerAttachment,
  WikiTiddlerClickData,
} from "./types.js";

// ── Controllers ────────────────────────────────────────────────────

export { AgentSessionController } from "./AgentSessionController.js";
export type {
  AgentSessionControllerOptions,
  AgentSessionListener,
  AgentSessionSnapshot,
} from "./AgentSessionController.js";

export { AgentDefinitionEditorController } from "./AgentDefinitionEditorController.js";
export type {
  AgentDefinitionEditorControllerOptions,
  EditorStateChange,
  EditorStateListener,
  ScheduleEditorState,
} from "./AgentDefinitionEditorController.js";

export { AgentCreationController } from "./AgentCreationController.js";
export type {
  AgentCreationControllerOptions,
  CreationStateListener,
} from "./AgentCreationController.js";

export { PromptPreviewController } from "./PromptPreviewController.js";
export type {
  PreviewDialogListener,
  PromptPreviewControllerOptions,
} from "./PromptPreviewController.js";

