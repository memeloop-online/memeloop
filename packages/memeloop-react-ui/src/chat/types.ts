import type { ConversationMessageListProjection } from 'memeloop';
import type { ReactNode } from 'react';

import type {
  MemeLoopAttachmentSelectionContext,
  MemeLoopChatAdapter,
  MemeLoopSelectedAttachmentBatch,
  MemeLoopSendMessageInput,
  MessageDetailLoader,
  WikiTiddlerAttachment,
  WikiTiddlerClickData,
} from './coreTypes.js';
import type { MemeLoopVisibleAttachmentLoader } from './visibleAttachmentHydration.js';

export type { MemeLoopAttachmentPolicy, MemeLoopAttachmentValidationErrorCode } from './attachmentValidation.js';
export type {
  AgentExecutionTarget,
  ConversationTimelineCompactionEntry,
  ConversationTimelineEntry,
  ConversationTimelineLabels,
  ConversationTimelineMessageEntry,
  ConversationTimelineMessageRole,
  ConversationTimelinePage,
  ConversationTimelinePageReset,
  ConversationTimelinePageSuccess,
  MemeLoopAttachmentSelectionContext,
  MemeLoopChatAdapter,
  MemeLoopChatErrorPresentation,
  MemeLoopChatOperation,
  MemeLoopSelectedAttachmentBatch,
  MemeLoopSendMessageInput,
  MessageDetailLoader,
  SetExecutionTargetOptions,
  WikiTiddlerAttachment,
  WikiTiddlerClickData,
} from './coreTypes.js';

export interface WebMemeLoopSendMessageInput extends MemeLoopSendMessageInput {
  file?: File;
}

export interface WebMemeLoopChatAdapter extends Omit<MemeLoopChatAdapter, 'sendMessage'> {
  sendMessage: (input: WebMemeLoopSendMessageInput) => Promise<void>;
}

export interface MemeLoopThreadProps {
  header?: ReactNode;
  footer?: ReactNode;
  empty?: ReactNode;
  renderMessageContent?: (message: ConversationMessageListProjection, isUser: boolean) => ReactNode;
  renderTurnActions?: (message: ConversationMessageListProjection) => ReactNode;
  onWikiTiddlerClick?: (tiddler: WikiTiddlerClickData) => void;
  loadMessageDetail?: MessageDetailLoader;
  loadMessageReasoning?: import('./messageReasoning.js').MemeLoopMessageReasoningLoader;
  loadVisibleAttachments?: MemeLoopVisibleAttachmentLoader;
  /** Optional host/page revision included in the lazy attachment identity. */
  attachmentRevision?: string;
  composerComponent?: React.ComponentType;
  className?: string;
  showTimeline?: boolean;
  timelineLabels?: Partial<import('./coreTypes.js').ConversationTimelineLabels>;
  /** Host locale-aware formatter. No platform-default locale is read by this package. */
  formatTimelineTimestamp?: (timestamp: number) => string;
  messageLabels?: Partial<import('./thread/MemeLoopMessage.js').MemeLoopMessageLabels>;
  renderOperationError?: (error: Error) => ReactNode;
  operationErrorOverride?: Error;
  onClearOperationErrorOverride?: () => void;
  /** Localized fail-closed fallback. Raw exception messages are never rendered. */
  operationErrorMessage?: string;
}

export interface DroppedAttachmentSnapshot {
  files: readonly File[];
  /** Synchronously copied before the browser invalidates the live DataTransfer. */
  stringData: Readonly<Record<string, string>>;
}

export type WebSelectedAttachmentBatch = MemeLoopSelectedAttachmentBatch<File>;

export type DroppedAttachmentResolver = (
  snapshot: DroppedAttachmentSnapshot,
  context: MemeLoopAttachmentSelectionContext,
) => Promise<readonly WikiTiddlerAttachment[]> | readonly WikiTiddlerAttachment[];

export interface MemeLoopMessageProps {
  message: ConversationMessageListProjection;
  isStreaming?: boolean;
  renderContent?: (message: ConversationMessageListProjection, isUser: boolean) => ReactNode;
  renderTurnActions?: (message: ConversationMessageListProjection) => ReactNode;
  onWikiTiddlerClick?: (tiddler: WikiTiddlerClickData) => void;
  loadMessageDetail?: MessageDetailLoader;
  loadMessageReasoning?: import('./messageReasoning.js').MemeLoopMessageReasoningLoader;
  loadVisibleAttachments?: MemeLoopVisibleAttachmentLoader;
  attachmentRevision?: string;
  onAttachmentHydrationError?: (error: Error) => void;
  /** Thread-owned single-open detail budget. Omit for a standalone message. */
  detailDisplayActive?: boolean;
  onActivateDetailDisplay?: (messageId: string) => void;
  exportMessage?: (messageId: string, options: { signal: AbortSignal }) => Promise<void>;
  labels?: Partial<import('./thread/MemeLoopMessage.js').MemeLoopMessageLabels>;
}

export interface AttachmentPickerControls {
  disabled: boolean;
  openFilePicker: () => void;
  selectWikiTiddler: (tiddler: WikiTiddlerAttachment) => void;
}

export interface MemeLoopComposerLabels {
  input: string;
  send: string;
  cancel: string;
  addFile: string;
  removeFile: (fileName: string) => string;
  removeTiddler: (workspaceName: string, tiddlerTitle: string) => string;
}

export interface MemeLoopComposerProps {
  labels?: Partial<MemeLoopComposerLabels>;
  onFileSelect?: (file: File) => void;
  onWikiTiddlerSelect?: (tiddler: WikiTiddlerAttachment) => void;
  selectedFile?: File;
  selectedWikiTiddlers?: readonly WikiTiddlerAttachment[];
  onClearFile?: () => void;
  onClearAttachments?: () => void;
  onRemoveWikiTiddler?: (index: number) => void;
  renderAttachmentActions?: ReactNode;
  renderAttachmentPicker?: (controls: AttachmentPickerControls) => ReactNode;
  renderComposerToolbar?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
}
