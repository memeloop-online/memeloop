import { createStorageTUIMessageWindowSource } from '../../tui/storageMessageWindowSource.js';
import type { ChatHooks } from '../hooks.js';
import type { ChatHookContext } from '../types.js';

export function registerSessionResumeHandler(hooks: ChatHooks) {
  hooks.beforeTUIRender.tapAsync('session-resume', (context, callback) => {
    void resumeSession(context).then(() => {
      callback();
    }, callback);
  });
}

export async function resumeSession(context: ChatHookContext): Promise<void> {
  if (!context.options.continueLast && !context.options.resumeSessionId) return;
  if (!context.runtime) return;

  const { listSessions } = await import('../../sessions.js');

  let sessionId = context.options.resumeSessionId?.trim();
  let statusText: string | undefined;
  if (!sessionId) {
    const sessions = await listSessions(context.runtime);
    if (sessions && !sessions.reset && sessions.sessions.length > 0) {
      const selected = sessions.sessions[0];
      sessionId = selected.conversationId;
      statusText = `Resumed: ${selected.title} (${selected.messageCount} messages)`;
    }
  }

  if (sessionId) {
    await context.tui.openConversation(
      createStorageTUIMessageWindowSource(context.runtime.storage),
      sessionId,
    );
    context.tui.setStatus(statusText ?? `Resumed session: ${sessionId}`);
  }
}
