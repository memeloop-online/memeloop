import type { IAgentStorage, IToolRegistry, ToolOperationEffect } from 'memeloop';

import type { IWikiManager } from '../knowledge/wikiManager.js';
import type { ITerminalSessionManager } from '../terminal/index.js';
import { registerDemoTools } from './demo.js';
import { registerFileTools } from './fileSystem.js';
import { registerGenericNodeTools } from './genericNodeTools.js';
import { registerCoreNodeTools } from './registerCoreNodeTools.js';
import { registerScreenshotTool } from './screenshot.js';
import { registerTerminalTools } from './terminal.js';
import { registerVscodeTools } from './vscodeCli.js';
import { registerWikiTools } from './wikiTools.js';

/**
 * Registers memeloop-cli environment tools (file / wiki / terminal / generic / optional VS Code CLI)
 * on any `IToolRegistry`. Used by `createNodeRuntime` and by TidGi-Desktop's MemeLoop worker embed.
 */
export interface RegisterNodeEnvironmentToolsOptions {
  /** Stable, globally unique identity for every cross-device resource reference. */
  nodeId: string;
  /** When set, registers `terminal.*` tools. */
  terminalManager?: ITerminalSessionManager;
  /** Root for `file.*` tools; defaults to `process.cwd()`. */
  fileBaseDir?: string;
  /** When set, registers `knowledge.*` / wiki-backed tools for this manager. */
  wikiManager?: IWikiManager;
  /** First argument to `registerWikiTools` (e.g. `"default"`). */
  wikiDefaultId?: string;
  /**
   * CLI node enables VS Code CLI tools; Electron worker usually sets `false` (no `code` in PATH semantics).
   * @default true
   */
  includeVscodeCli?: boolean;
  /** When set with `terminalManager`, terminal output is persisted under `terminal:<sessionId>`. */
  storage?: IAgentStorage;
  /** For `terminal.start` interactive mode (host UI / IM bridge). */
  terminalAskQuestion?: (question: string) => Promise<string>;
}

interface OwnedToolRegistry extends IToolRegistry {
  registerOwnedTool?(
    id: string,
    impl: unknown,
    parameterSchema?: unknown,
    effect?: ToolOperationEffect,
  ): () => boolean;
}

export interface OwnedToolRegistrationScope {
  /** Registration-only facade that records exact ownership for later teardown. */
  registry: IToolRegistry;
  /** Idempotently removes only registrations still owned by this scope. */
  dispose(): void;
}

/**
 * Create an ownership boundary around legacy `registerTool()` registrars.
 * Strong registries use owner tokens; structural embedders fall back to an
 * implementation-identity check so a later host replacement is never removed.
 */
export function createOwnedToolRegistrationScope(
  registry: IToolRegistry,
): OwnedToolRegistrationScope {
  const cleanup: Array<() => void> = [];
  let accepting = true;
  let disposed = false;
  const registerTool = (
    id: string,
    impl: unknown,
    parameterSchema?: unknown,
    effect?: ToolOperationEffect,
  ): void => {
    if (!accepting) throw new Error('Tool registration scope is closed');
    const ownedRegistry = registry as OwnedToolRegistry;
    if (typeof ownedRegistry.registerOwnedTool === 'function') {
      const unregister = ownedRegistry.registerOwnedTool(
        id,
        impl,
        parameterSchema,
        effect,
      );
      cleanup.push(() => {
        unregister();
      });
      return;
    }
    registry.registerTool(id, impl, parameterSchema, effect);
    cleanup.push(() => {
      if (registry.getTool(id) === impl) registry.unregisterTool?.(id);
    });
  };
  const scopedRegistry = new Proxy(registry, {
    get(target, property) {
      if (property === 'registerTool') return registerTool;
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      const method = value as (...arguments_: unknown[]) => unknown;
      return (...arguments_: unknown[]): unknown => {
        const result: unknown = Reflect.apply(method, target, arguments_);
        return result;
      };
    },
  });
  return {
    registry: scopedRegistry,
    dispose() {
      if (disposed) return;
      disposed = true;
      accepting = false;
      const errors: unknown[] = [];
      for (const unregister of cleanup.reverse()) {
        try {
          unregister();
        } catch (error) {
          errors.push(error);
        }
      }
      cleanup.length = 0;
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Node tool registration cleanup failed');
      }
    },
  };
}

export function registerNodeEnvironmentTools(
  registry: IToolRegistry,
  options: RegisterNodeEnvironmentToolsOptions,
): () => void {
  if (!options.nodeId.trim()) {
    throw new Error('registerNodeEnvironmentTools requires a stable nodeId');
  }
  const scope = createOwnedToolRegistrationScope(registry);
  const additionalCleanup: Array<() => void> = [];
  let cleaned = false;
  const disposeRegistrations = (): void => {
    if (cleaned) return;
    cleaned = true;
    const errors: unknown[] = [];
    for (const cleanup of additionalCleanup.reverse()) {
      try {
        cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      scope.dispose();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Node environment tool cleanup failed');
    }
  };
  try {
    // Core Node tools (bash, file*, grep, glob, webSearch, lsp) — from memeloop builtins
    registerCoreNodeTools(scope.registry);

    if (options.terminalManager) {
      registerTerminalTools(scope.registry, options.terminalManager, {
        storage: options.storage,
        nodeId: options.nodeId,
        askQuestion: options.terminalAskQuestion,
      });
    }
    const fileBase = options.fileBaseDir ?? process.cwd();
    registerFileTools(scope.registry, fileBase, { nodeId: options.nodeId });
    if (options.wikiManager) {
      registerWikiTools(scope.registry, options.wikiManager, options.wikiDefaultId ?? 'default');
    }
    if (options.includeVscodeCli !== false) {
      registerVscodeTools(scope.registry);
    }
    registerGenericNodeTools(scope.registry);
    registerScreenshotTool(scope.registry);
    additionalCleanup.push(registerDemoTools(scope.registry));
    return () => {
      disposeRegistrations();
    };
  } catch (error) {
    try {
      disposeRegistrations();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Node environment tool registration and rollback failed',
      );
    }
    throw error;
  }
}
