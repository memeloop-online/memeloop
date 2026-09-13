import type { ConversationTimelineLabels } from '../chat/types.js';

export interface NativeAgentChatLabels {
  user: string;
  agent: string;
  waitingPlaceholder: string;
  loadDetails: string;
  reloadDetails: string;
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
  user: 'You',
  agent: 'Agent',
  waitingPlaceholder: 'Waiting for response...',
  loadDetails: 'Load details',
  reloadDetails: 'Reload details',
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
