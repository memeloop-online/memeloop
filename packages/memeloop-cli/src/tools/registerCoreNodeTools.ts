/**
 * Registers Node-specific tools (moved from memeloop core builtins).
 *
 * These tools depend on Node.js APIs (node:fs, node:child_process, node:crypto)
 * and are registered into memeloop's IToolRegistry framework.
 */
import type { IToolRegistry } from 'memeloop';

import { BASH_TOOL_ID, bashImpl, bashSchema } from './bash.js';
import { FILE_EDIT_TOOL_ID, fileEditConfigSchema, fileEditImpl } from './fileEdit.js';
import { FILE_READ_TOOL_ID, fileReadConfigSchema, fileReadImpl } from './fileRead.js';
import { FILE_WRITE_TOOL_ID, fileWriteConfigSchema, fileWriteImpl } from './fileWrite.js';
import { GLOB_TOOL_ID, globConfigSchema, globImpl } from './glob.js';
import { GREP_TOOL_ID, grepConfigSchema, grepImpl } from './grep.js';
import { LSP_TOOL_ID, lspConfigSchema, lspImpl } from './lsp.js';
import { WEB_SEARCH_TOOL_ID, webSearchConfigSchema, webSearchImpl } from './webSearch.js';

export function registerCoreNodeTools(registry: IToolRegistry): void {
  registry.registerTool(BASH_TOOL_ID, (arguments_: Record<string, unknown>) => bashImpl(arguments_), bashSchema);
  registry.registerTool(
    FILE_READ_TOOL_ID,
    (arguments_: Record<string, unknown>) => fileReadImpl(arguments_),
    fileReadConfigSchema,
  );
  registry.registerTool(
    FILE_WRITE_TOOL_ID,
    (arguments_: Record<string, unknown>) => fileWriteImpl(arguments_),
    fileWriteConfigSchema,
  );
  registry.registerTool(
    FILE_EDIT_TOOL_ID,
    (arguments_: Record<string, unknown>) => fileEditImpl(arguments_),
    fileEditConfigSchema,
  );
  registry.registerTool(
    GREP_TOOL_ID,
    (arguments_: Record<string, unknown>) => grepImpl(arguments_),
    grepConfigSchema,
  );
  registry.registerTool(
    GLOB_TOOL_ID,
    (arguments_: Record<string, unknown>) => globImpl(arguments_),
    globConfigSchema,
  );
  registry.registerTool(
    WEB_SEARCH_TOOL_ID,
    (arguments_: Record<string, unknown>) => webSearchImpl(arguments_),
    webSearchConfigSchema,
  );
  registry.registerTool(
    LSP_TOOL_ID,
    (arguments_: Record<string, unknown>) => lspImpl(arguments_),
    lspConfigSchema,
  );
}
