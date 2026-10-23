import type { HookSlot, PromptConcatHooks, PromptConcatTool, TapAsyncHandler } from './types.js';

/** Lightweight hook slot：tapAsync 注册，promise 串行执行（对齐 TidGi tapable AsyncSeriesHook） */
function createHookSlot(): HookSlot & {
  handlers: TapAsyncHandler[];
} {
  const handlers: TapAsyncHandler[] = [];
  return {
    handlers,
    tapAsync(_name, function_) {
      handlers.push(function_);
    },
    async promise(context: unknown) {
      for (const function_ of handlers) {
        await new Promise<void>((resolve) => {
          function_(context, resolve);
        });
      }
    },
  };
}

export function createAgentFrameworkHooks(): PromptConcatHooks {
  return {
    processPrompts: createHookSlot(),
    finalizePrompts: createHookSlot(),
    postProcess: createHookSlot(),
    userMessageReceived: createHookSlot(),
    agentStatusChanged: createHookSlot(),
    toolExecuted: createHookSlot(),
    responseUpdate: createHookSlot(),
    responseComplete: createHookSlot(),
  };
}

export async function runProcessPromptsHooks<TContext>(
  _hooks: PromptConcatHooks,
  context: TContext,
): Promise<TContext> {
  await _hooks.processPrompts.promise(context);
  return context;
}

export async function runResponseCompleteHooks(
  hooks: PromptConcatHooks,
  context: unknown,
): Promise<void> {
  await hooks.responseComplete.promise(context);
}

export async function runPostProcessHooks(
  hooks: PromptConcatHooks,
  context: unknown,
): Promise<void> {
  await hooks.postProcess.promise(context);
}

export async function runToolExecutedHooks(
  hooks: PromptConcatHooks,
  context: unknown,
): Promise<void> {
  await hooks.toolExecuted.promise(context);
}

/**
 * TidGi `createHooksWithPlugins`：按 agentFrameworkConfig.plugins 把插件注册表里的工具挂到 hooks。
 */
/** Resolve the prompt-plugin registry owned by this runtime. */
export function resolvePromptPluginMap(context: {
  promptPlugins?: Map<string, PromptConcatTool>;
  tools?: { getPromptPlugins?: () => Map<string, PromptConcatTool> };
}): Map<string, PromptConcatTool> {
  if (context.promptPlugins) return context.promptPlugins;
  const fromTools = context.tools?.getPromptPlugins?.();
  if (fromTools) return fromTools;
  throw new PromptPluginRegistryRequiredError();
}

export class PromptPluginRegistryRequiredError extends Error {
  readonly code = 'PROMPT_PLUGIN_REGISTRY_REQUIRED' as const;

  constructor() {
    super('Prompt plugins require a runtime-scoped registry');
    this.name = 'PromptPluginRegistryRequiredError';
  }
}

export class PromptPluginNotFoundError extends Error {
  readonly code = 'PROMPT_PLUGIN_NOT_FOUND' as const;

  constructor(readonly toolId: string) {
    super(`Configured prompt plugin is not registered: ${toolId}`);
    this.name = 'PromptPluginNotFoundError';
  }
}

export async function createHooksWithPlugins(
  agentFrameworkConfig: {
    plugins?: Array<{ toolId: string; [key: string]: unknown }>;
  },
  options: { pluginRegistry: Map<string, PromptConcatTool> },
): Promise<{
  hooks: PromptConcatHooks;
  pluginConfigs: Array<{ toolId: string; [key: string]: unknown }>;
}> {
  const reg = options.pluginRegistry;
  const hooks = createAgentFrameworkHooks();
  if (agentFrameworkConfig.plugins) {
    for (const pluginConfig of agentFrameworkConfig.plugins) {
      const { toolId } = pluginConfig;
      if (pluginConfig.enabled === false) continue;
      const plugin = reg.get(toolId);
      if (!plugin) {
        if (pluginConfig.optional === true) continue;
        throw new PromptPluginNotFoundError(toolId);
      }
      if (typeof plugin !== 'function') throw new TypeError(`Prompt plugin is not callable: ${toolId}`);
      plugin(hooks);
    }
  }
  return {
    hooks,
    pluginConfigs: agentFrameworkConfig.plugins ?? [],
  };
}
