import { executeCommand } from '../../commands.js';
import type { ChatHooks } from '../hooks.js';
import type { ChatHookContext } from '../types.js';

export function registerSlashCommandHandler(hooks: ChatHooks) {
  hooks.onUserMessage.tapAsync('slash-commands', (context, callback) => {
    void handleSlashCommand(context).then(() => {
      callback();
    }, callback);
  });
}

async function handleSlashCommand(context: ChatHookContext): Promise<void> {
  const text = context.currentText ?? '';
  if (!text.startsWith('/')) return;
  const cmdContext = {
    messages: context.tui.getMessages(),
    mode: context.tui.getMode(),
    statusText: '',
  };
  const result = await executeCommand(text, cmdContext);
  if (!result) return;

  context.messageHandled = true;

  if (result.exit) {
    context.tui.setStatus('Goodbye!');
    process.exit(0);
  }
  if (result.clearMessages) {
    context.tui.addMessage({
      id: `sys-${Date.now()}`,
      role: 'system',
      content: 'Conversation cleared.',
      timestamp: new Date(),
    });
    return;
  }
  if (result.messages) {
    for (const message of result.messages) {
      context.tui.addMessage(message);
    }
  }
  if (result.statusText) {
    context.tui.setStatus(result.statusText);
  }
}
