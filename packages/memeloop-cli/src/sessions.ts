/** Bounded, revision-consistent CLI session directory and resume reads. */
import { type ConversationMessageCursor, type ConversationMessageListProjection, type FullAgentStorage, readConversationMessagePage } from 'memeloop';

import type { NodeRuntimeResult } from './runtime/nodeRuntime.js';

const INTERACTIVE_PAGE_LIMIT = 50;
const INTERACTIVE_PAGE_MAX_BYTES = 256 * 1024;

export interface SessionInfo {
  conversationId: string;
  title: string;
  messageCount: number;
  lastMessageTimestamp: number;
  lastMessagePreview: string;
}

export interface SessionListOptions {
  beforeCursor?: string;
  afterCursor?: string;
  expectedRevision?: string;
  signal?: AbortSignal;
}

export type SessionListPage =
  | { reset: true; revision: string }
  | {
    reset: false;
    sessions: SessionInfo[];
    revision: string;
    total: number;
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
    startCursor?: string;
    endCursor?: string;
  };

export interface SessionResumeOptions {
  before?: ConversationMessageCursor;
  after?: ConversationMessageCursor;
  expectedRevision?: string;
  signal?: AbortSignal;
}

export type SessionResumePage =
  | { reset: true; conversationId: string; revision: string }
  | {
    reset: false;
    messages: ConversationMessageListProjection[];
    conversationId: string;
    revision: string;
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
    startCursor?: ConversationMessageCursor;
    endCursor?: ConversationMessageCursor;
  };

interface CancelAgentCapability {
  cancelAgent(conversationId: string): Promise<void>;
}

function hasCancelAgent(storage: FullAgentStorage): storage is FullAgentStorage & CancelAgentCapability {
  return 'cancelAgent' in storage && typeof storage.cancelAgent === 'function';
}

function sessionStorage(runtime: NodeRuntimeResult): FullAgentStorage | null {
  const storage = runtime.storage;
  return storage === null || typeof storage !== 'object' ? null : storage;
}

/** Read at most 50 directory entries / 256 KiB without scanning the full store. */
export async function listSessions(
  runtime: NodeRuntimeResult,
  options: SessionListOptions = {},
): Promise<SessionListPage | null> {
  const storage = sessionStorage(runtime);
  if (typeof storage?.listConversationsPage !== 'function') return null;

  try {
    options.signal?.throwIfAborted();
    const page = await storage.listConversationsPage({
      limit: INTERACTIVE_PAGE_LIMIT,
      maxBytes: INTERACTIVE_PAGE_MAX_BYTES,
      ...(options.beforeCursor === undefined ? {} : { beforeCursor: options.beforeCursor }),
      ...(options.afterCursor === undefined ? {} : { afterCursor: options.afterCursor }),
      ...(options.expectedRevision === undefined
        ? {}
        : { expectedRevision: options.expectedRevision }),
    }, { signal: options.signal });
    options.signal?.throwIfAborted();
    if (page.reset) return page;
    if (page.items.length > INTERACTIVE_PAGE_LIMIT || encodedBytes(page) > INTERACTIVE_PAGE_MAX_BYTES) {
      throw new Error('invalid bounded conversation directory page');
    }
    return {
      reset: false,
      sessions: page.items.map(conversation => ({
        conversationId: conversation.conversationId,
        title: conversation.title || conversation.conversationId.slice(0, 12),
        messageCount: conversation.messageCount,
        lastMessageTimestamp: conversation.lastMessageTimestamp,
        lastMessagePreview: conversation.lastMessagePreview,
      })),
      revision: page.revision,
      total: page.total,
      hasMoreBefore: page.hasMoreBefore,
      hasMoreAfter: page.hasMoreAfter,
      ...(page.startCursor === undefined ? {} : { startCursor: page.startCursor }),
      ...(page.endCursor === undefined ? {} : { endCursor: page.endCursor }),
    };
  } catch {
    if (options.signal?.aborted) options.signal.throwIfAborted();
    return null;
  }
}

/** Read one recent 50-message / 256 KiB page for interactive resume. */
export async function resumeSession(
  runtime: NodeRuntimeResult,
  sessionId: string,
  options: SessionResumeOptions = {},
): Promise<SessionResumePage | null> {
  const storage = sessionStorage(runtime);
  if (typeof storage?.getMessagePage !== 'function' || sessionId.trim().length === 0) return null;

  try {
    const page = await readConversationMessagePage(
      storage,
      sessionId,
      {
        limit: INTERACTIVE_PAGE_LIMIT,
        maxBytes: INTERACTIVE_PAGE_MAX_BYTES,
        ...(options.before === undefined ? {} : { before: options.before }),
        ...(options.after === undefined ? {} : { after: options.after }),
        ...(options.expectedRevision === undefined
          ? {}
          : { expectedRevision: options.expectedRevision }),
      },
      { signal: options.signal },
    );
    if (page.reset) return page;
    if (page.items.length === 0) return null;
    return {
      reset: false,
      messages: page.items,
      conversationId: page.conversationId,
      revision: page.revision,
      hasMoreBefore: page.hasMoreBefore,
      hasMoreAfter: page.hasMoreAfter,
      ...(page.startCursor === undefined ? {} : { startCursor: page.startCursor }),
      ...(page.endCursor === undefined ? {} : { endCursor: page.endCursor }),
    };
  } catch {
    if (options.signal?.aborted) options.signal.throwIfAborted();
    return null;
  }
}

export async function deleteSession(
  runtime: NodeRuntimeResult,
  sessionId: string,
): Promise<boolean> {
  const storage = sessionStorage(runtime);
  if (!storage || !hasCancelAgent(storage)) return false;

  try {
    await storage.cancelAgent(sessionId);
    return true;
  } catch {
    return false;
  }
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
