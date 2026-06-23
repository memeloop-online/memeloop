import { render } from 'ink';
import React from 'react';
import { TUIApp } from '../../tui/index.js';
import type { ChatHooks } from '../hooks.js';
import type { ChatHookContext } from '../types.js';
import { handleUserMessage } from './messageHandler.js';

export function registerTUIRenderHandler(hooks: ChatHooks) {
  hooks.renderTUI.tapAsync('default', (context, callback) => {
    void renderTUI(context, hooks).then(() => {
      callback();
    }, callback);
  });
}

async function renderTUI(context: ChatHookContext, hooks: ChatHooks): Promise<void> {
  const { waitUntilExit } = render(
    React.createElement(TUIApp, {
      initialMessages: context.initialMessages,
      onSubmit: (text: string) => handleUserMessage(text, context, hooks),
      onPermissionResponse: (_requestId: string, approved: boolean) => {
        context.tui.resolvePermission(approved);
      },
      onExit: () => {
        context.tui.setStatus('Shutting down...');
      },
    }),
  );
  await waitUntilExit();
}
