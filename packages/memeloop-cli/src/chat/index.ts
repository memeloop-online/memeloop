import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTUIDispatcher } from '../tui/index.js';
import { createChatHooks } from './hooks.js';
import type { ChatOptions } from './types.js';

import { registerAgentRunnerHandler } from './handlers/agentRunner.js';
import { registerPrintModeHandler } from './handlers/printMode.js';
import { registerRuntimeInitHandler } from './handlers/runtimeInit.js';
import { registerSessionResumeHandler } from './handlers/sessionResume.js';
import { registerSlashCommandHandler } from './handlers/slashCommands.js';
import { registerTUIRenderHandler } from './handlers/tuiRender.js';

export type { ChatOptions } from './types.js';

/**
 * Launch the interactive TUI chat.
 *
 * Main flow — kept intentionally slim. All concrete logic lives in
 * hook handlers registered below.
 */
export async function launchChat(options: ChatOptions = {}): Promise<void> {
  const hooks = createChatHooks();
  const context = {
    options,
    dataDir: options.dataDir ?? path.join(os.homedir(), '.memeloop'),
    tui: createTUIDispatcher(),
    runtime: undefined,
    initialMessages: [] as import('../tui/types.js').TUIMessage[],
    providerMissingHandled: false,
    providerMissingAction: 'exit' as 'retry' | 'continue' | 'exit',
    messageHandled: false,
  };

  // Register default handlers
  registerPrintModeHandler(hooks);
  registerRuntimeInitHandler(hooks);
  registerSessionResumeHandler(hooks);
  registerSlashCommandHandler(hooks);
  registerAgentRunnerHandler(hooks);
  registerTUIRenderHandler(hooks);

  // Ensure data directory exists
  mkdirSync(context.dataDir, { recursive: true });

  await hooks.beforeLaunch.promise(context);

  if (context.options.print) {
    await hooks.runPrintMode.promise(context);
    return;
  }

  await hooks.initRuntime.promise(context);
  if (!context.runtime) return;

  await hooks.beforeTUIRender.promise(context);
  await hooks.renderTUI.promise(context);
  await hooks.afterTUIExit.promise(context);
}
