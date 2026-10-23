import type { ChatHooks } from '../hooks.js';
import type { ChatHookContext } from '../types.js';
import { createCliAgentRunner, hasValidProvider } from '../types.js';

export async function handleUserMessage(
  text: string,
  context: ChatHookContext,
  hooks: ChatHooks,
): Promise<void> {
  context.currentText = text;
  context.messageHandled = false;
  context.error = undefined;
  context.responseContent = '';

  await hooks.onUserMessage.promise(context);
  if (context.messageHandled) return;

  if (!hasValidProvider(context.runtime!)) {
    context.tui.setThinking(false);
    context.tui.setStatus('No provider');
    return;
  }

  context.conversationId = `cli-chat-${Date.now().toString(36)}`;
  const runAgent = await createCliAgentRunner(context.runtime!, context.conversationId);
  if (!runAgent) {
    context.tui.setThinking(false);
    context.tui.setStatus('Error');
    return;
  }
  context.tui.setStatus('Agent running...');

  await hooks.beforeAgentRun.promise(context);
  if (context.messageHandled) return;

  try {
    const gen = runAgent({
      conversationId: context.conversationId,
      message: text,
    });
    for await (const step of gen) {
      context.currentStep = step;
      await hooks.onAgentStep.promise(context);
    }
    await hooks.afterAgentRun.promise(context);
  } catch (error) {
    context.error = error as Error;
    await hooks.onAgentError.promise(context);
  }
}
