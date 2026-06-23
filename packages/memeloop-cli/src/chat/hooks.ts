import type { ChatHookContext } from './types.js';

export interface HookSlot {
  tapAsync(name: string, function_: (context: ChatHookContext, callback: () => void) => void): void;
  promise(context: ChatHookContext): Promise<void>;
}

export function createHookSlot(): HookSlot {
  const handlers: Array<(context: ChatHookContext, callback: () => void) => void> = [];
  return {
    tapAsync(_name, function_) {
      handlers.push(function_);
    },
    async promise(context) {
      for (const function_ of handlers) {
        await new Promise<void>((resolve) => {
          function_(context, resolve);
        });
      }
    },
  };
}

export interface ChatHooks {
  beforeLaunch: HookSlot;
  runPrintMode: HookSlot;
  initRuntime: HookSlot;
  onProviderMissing: HookSlot;
  beforeTUIRender: HookSlot;
  renderTUI: HookSlot;
  onUserMessage: HookSlot;
  beforeAgentRun: HookSlot;
  onAgentStep: HookSlot;
  afterAgentRun: HookSlot;
  onAgentError: HookSlot;
  afterTUIExit: HookSlot;
}

export function createChatHooks(): ChatHooks {
  return {
    beforeLaunch: createHookSlot(),
    runPrintMode: createHookSlot(),
    initRuntime: createHookSlot(),
    onProviderMissing: createHookSlot(),
    beforeTUIRender: createHookSlot(),
    renderTUI: createHookSlot(),
    onUserMessage: createHookSlot(),
    beforeAgentRun: createHookSlot(),
    onAgentStep: createHookSlot(),
    afterAgentRun: createHookSlot(),
    onAgentError: createHookSlot(),
    afterTUIExit: createHookSlot(),
  };
}
