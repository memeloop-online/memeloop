import type { ConversationTimelineLabels } from '../chat/types.js';
import type { MessageEditorLabels } from '../chat/useMessageEditor.js';

export interface NativeAgentChatLabels {
  editing?: Partial<MessageEditorLabels>;
  working: string;
  completedWork: (steps: number) => string;
  toolGroup: (steps: number) => string;
  toolInput: string;
  toolResult: string;
  toolInputTruncated: string;
  user: string;
  agent: string;
  waitingPlaceholder: string;
  loadDetails: string;
  reloadDetails: string;
  /** Label for fetching the next bounded detail page when a cursor is present. */
  loadMoreDetails?: string;
  noDetails: string;
  attachment: (filename: string) => string;
  addAttachment: string;
  replaceAttachment: (filename: string) => string;
  removeAttachment: (filename: string) => string;
  selectedAttachment: (filename: string) => string;
  detailTruncated: string;
  exportFullMessage: string;
  close: string;
  truncatedMessage: (characters: number) => string;
  diagnosticId: (id: string) => string;
  /** Localized, host-overridable timestamp used by native timeline markers. */
  timelineTimestamp: (timestamp: number) => string;
}

export const DEFAULT_NATIVE_AGENT_CHAT_LABELS: NativeAgentChatLabels = {
  working: 'Working…',
  completedWork: steps => `Completed work · ${steps} steps`,
  toolGroup: steps => `${steps} tool calls`,
  toolInput: 'Command / arguments',
  toolResult: 'Result',
  toolInputTruncated: 'Arguments exceed the preview limit. Open details for more.',
  user: 'You',
  agent: 'Agent',
  waitingPlaceholder: 'Waiting for response...',
  loadDetails: 'Load details',
  reloadDetails: 'Reload details',
  loadMoreDetails: 'Load more details',
  noDetails: 'No details available.',
  attachment: filename => `Attachment: ${filename}`,
  addAttachment: 'Add image',
  replaceAttachment: filename => `Replace image: ${filename}`,
  removeAttachment: filename => `Remove image: ${filename}`,
  selectedAttachment: filename => `Selected image: ${filename}`,
  detailTruncated: 'Only a bounded detail fragment is shown. Export the conversation for complete content.',
  exportFullMessage: 'Export full message',
  close: 'Close',
  truncatedMessage: characters => `Message shortened for display (${characters} characters).`,
  diagnosticId: id => `Diagnostic ID: ${id}`,
  timelineTimestamp: timestamp => new Date(timestamp).toLocaleString(),
};

export const DEFAULT_NATIVE_TIMELINE_LABELS: ConversationTimelineLabels = {
  navigation: 'Conversation timeline',
  message: (index, total, role) => `${role} message ${index} of ${total}`,
  compacted: count => `${count} earlier messages compacted`,
  loadEarlier: 'Load earlier messages',
  loadLater: 'Load later messages',
  seek: 'Seek conversation timeline',
  close: 'Close',
  newMessages: count => `${count} new message${count === 1 ? '' : 's'}`,
};

export function resolveNativeAgentChatLabels(
  labels?: Partial<NativeAgentChatLabels>,
): NativeAgentChatLabels {
  return { ...DEFAULT_NATIVE_AGENT_CHAT_LABELS, ...labels };
}

export function resolveNativeTimelineLabels(
  labels?: Partial<ConversationTimelineLabels>,
): ConversationTimelineLabels {
  return { ...DEFAULT_NATIVE_TIMELINE_LABELS, ...labels };
}
