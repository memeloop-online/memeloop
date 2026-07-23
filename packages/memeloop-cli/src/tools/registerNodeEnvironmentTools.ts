import type { IAgentStorage, IToolRegistry } from 'memeloop';

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
  /** `originNodeId` / `DetailRef.nodeId` for terminal + file tools. */
  nodeId?: string;
  /** For `terminal.start` interactive mode (host UI / IM bridge). */
  terminalAskQuestion?: (question: string) => Promise<string>;
}

export function registerNodeEnvironmentTools(
  registry: IToolRegistry,
  options: RegisterNodeEnvironmentToolsOptions = {},
): void {
  // Core Node tools (bash, file*, grep, glob, webSearch, lsp) — from memeloop builtins
  registerCoreNodeTools(registry);

  if (options.terminalManager) {
    registerTerminalTools(registry, options.terminalManager, {
      storage: options.storage,
      nodeId: options.nodeId,
      askQuestion: options.terminalAskQuestion,
    });
  }
  const fileBase = options.fileBaseDir ?? process.cwd();
  registerFileTools(registry, fileBase, { nodeId: options.nodeId });
  if (options.wikiManager) {
    registerWikiTools(registry, options.wikiManager, options.wikiDefaultId ?? 'default');
  }
  if (options.includeVscodeCli !== false) {
    registerVscodeTools(registry);
  }
  registerGenericNodeTools(registry);
  registerScreenshotTool(registry);
  registerDemoTools(registry);
}
