import type { FullAgentStorage, IToolRegistry } from 'memeloop';

import type { IWikiManager } from '../knowledge/wikiManager.js';
import type { ITerminalSessionManager } from '../terminal/index.js';
import { registerDemoTools } from './demo.js';
import { registerFileTools } from './fileSystem.js';
import { registerGenericNodeTools } from './genericNodeTools.js';
import { requireOwnedToolRegistry } from './ownedToolRegistry.js';
import { registerCoreNodeTools } from './registerCoreNodeTools.js';
import { registerScreenshotTool } from './screenshot.js';
import { registerTerminalTools } from './terminal.js';
import { registerVscodeTools } from './vscodeCli.js';
import { registerWikiTools } from './wikiTools.js';

/**
 * Registers memeloop-cli environment tools (file / wiki / terminal / generic / optional VS Code CLI)
 * on an ownership-aware tool registry. Used by `createNodeRuntime` and by TidGi-Desktop's MemeLoop worker embed.
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
  storage?: FullAgentStorage;
  /** For `terminal.start` interactive mode (host UI / IM bridge). */
  terminalAskQuestion?: (question: string) => Promise<string>;
}

export function registerNodeEnvironmentTools(
  registry: IToolRegistry,
  options: RegisterNodeEnvironmentToolsOptions,
): () => void {
  if (!options.nodeId.trim()) {
    throw new Error('registerNodeEnvironmentTools requires a stable nodeId');
  }
  const ownedRegistry = requireOwnedToolRegistry(registry);
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
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Node environment tool cleanup failed');
    }
  };
  try {
    // Core Node tools (bash, file*, grep, glob, webSearch, lsp) — from memeloop builtins
    additionalCleanup.push(registerCoreNodeTools(ownedRegistry));

    if (options.terminalManager) {
      additionalCleanup.push(registerTerminalTools(ownedRegistry, options.terminalManager, {
        storage: options.storage,
        nodeId: options.nodeId,
        askQuestion: options.terminalAskQuestion,
      }));
    }
    const fileBase = options.fileBaseDir ?? process.cwd();
    additionalCleanup.push(registerFileTools(ownedRegistry, fileBase, { nodeId: options.nodeId }));
    if (options.wikiManager) {
      additionalCleanup.push(registerWikiTools(ownedRegistry, options.wikiManager, options.wikiDefaultId ?? 'default'));
    }
    if (options.includeVscodeCli !== false) {
      additionalCleanup.push(registerVscodeTools(ownedRegistry));
    }
    additionalCleanup.push(registerGenericNodeTools(ownedRegistry));
    additionalCleanup.push(registerScreenshotTool(ownedRegistry));
    additionalCleanup.push(registerDemoTools(ownedRegistry));
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
