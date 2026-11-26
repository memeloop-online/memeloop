import { type AgentLoopStep, readConversationMessagePage } from 'memeloop';
import { conversationMessageProjectionToTUIMessage } from '../../tui/messageAdapter.js';
import type { PermissionRequest } from '../../tui/types.js';
import type { ChatHooks } from '../hooks.js';
import type { ChatHookContext } from '../types.js';

export function registerAgentRunnerHandler(hooks: ChatHooks) {
  hooks.onAgentStep.tapAsync('default', (context, callback) => {
    void handleAgentStep(context).then(() => {
      callback();
    }, callback);
  });

  hooks.afterAgentRun.tapAsync('default', (context, callback) => {
    void appendLatestCanonicalMessage(context).then(() => {
      context.tui.setThinking(false);
      context.tui.setStatus('Ready');
      callback();
    }, callback);
  });

  hooks.onAgentError.tapAsync('default', (context, callback) => {
    const error = context.error;
    context.tui.setThinking(false);
    context.tui.setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
    callback();
  });
}

async function appendLatestCanonicalMessage(context: ChatHookContext): Promise<void> {
  const conversationId = context.conversationId;
  const storage = context.runtime?.storage;
  if (!conversationId || !storage || typeof storage.getMessagePage !== 'function') return;
  const page = await readConversationMessagePage(storage, conversationId, {
    limit: 1,
    maxBytes: 256 * 1024,
    direction: 'backward',
  });
  if (page.reset || page.items.length === 0) return;
  const latest = page.items[page.items.length - 1];
  if (!latest || context.tui.getMessages().some(message => message.messageId === latest.messageId)) return;
  context.tui.addMessage(conversationMessageProjectionToTUIMessage(latest));
}

async function handleAgentStep(context: ChatHookContext): Promise<void> {
  const step = context.currentStep as AgentLoopStep;
  if (!step) return;

  if (step.type === 'message') {
    const data = typeof step.data === 'string'
      ? step.data
      : isContentRecord(step.data)
      ? step.data.content
      : '';
    context.responseContent = (context.responseContent ?? '') + data;
  } else if (step.type === 'tool') {
    if (isToolRecord(step.data) && typeof step.data.toolName === 'string') {
      context.tui.setStatus(`Running tool: ${step.data.toolName}`);
    }
  } else if (step.type === 'permission_request') {
    const pd = isPermissionRecord(step.data) ? step.data : {};
    const permRequest: PermissionRequest = {
      id: pd.requestId ?? `perm-${Date.now()}`,
      toolName: pd.toolName ?? 'unknown',
      toolInput: pd.toolInput ?? {},
      message: pd.message ?? 'Allow this tool?',
      actions: ['allow', 'deny'],
    };
    context.tui.setStatus('Waiting for permission...');
    const approved = await context.tui.waitForPermission(permRequest);
    context.tui.setStatus(approved ? 'Permission approved' : 'Permission denied');
  }
}

function isContentRecord(value: unknown): value is { content: string } {
  return isRecord(value) && typeof value.content === 'string';
}

function isToolRecord(value: unknown): value is { toolName: string } {
  return isRecord(value) && typeof value.toolName === 'string';
}

function isPermissionRecord(value: unknown): value is {
  requestId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  message?: string;
} {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
