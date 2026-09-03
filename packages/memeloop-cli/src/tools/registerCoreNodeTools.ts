/**
 * Registers Node-specific tools (moved from memeloop core builtins).
 *
 * These tools depend on Node.js APIs (node:fs, node:child_process, node:crypto)
 * and are registered into memeloop's IToolRegistry framework.
 */
import { bashSchema, bashTool } from './bash.js';
import { FILE_EDIT_TOOL_ID, fileEditConfigSchema, fileEditImpl } from './fileEdit.js';
import { FileHashStore } from './fileHashStore.js';
import { FILE_READ_TOOL_ID, fileReadConfigSchema, fileReadImpl } from './fileRead.js';
import { FILE_WRITE_TOOL_ID, fileWriteConfigSchema, fileWriteImpl } from './fileWrite.js';
import { GLOB_TOOL_ID, globConfigSchema, globImpl } from './glob.js';
import { GREP_TOOL_ID, grepConfigSchema, grepImpl } from './grep.js';
import { LSP_TOOL_ID, lspConfigSchema, lspImpl } from './lsp.js';
import { disposeOwnedToolRegistrations, type OwnedToolRegistry } from './ownedToolRegistry.js';
import { WEB_SEARCH_TOOL_ID, webSearchConfigSchema, webSearchImpl } from './webSearch.js';

export function registerCoreNodeTools(registry: OwnedToolRegistry): () => void {
  const fileHashStore = new FileHashStore();
  const cleanups: Array<() => boolean> = [];
  try {
    cleanups.push(registry.registerOwnedTool(
      bashTool.id,
      (arguments_: Record<string, unknown>) => bashTool.execute(bashSchema.parse(arguments_)),
      bashSchema,
      'execute',
    ));
    cleanups.push(registry.registerOwnedTool(
      FILE_READ_TOOL_ID,
      (arguments_: Record<string, unknown>) => fileReadImpl(arguments_, fileHashStore),
      fileReadConfigSchema,
      'read',
    ));
    cleanups.push(registry.registerOwnedTool(
      FILE_WRITE_TOOL_ID,
      (arguments_: Record<string, unknown>) => fileWriteImpl(arguments_),
      fileWriteConfigSchema,
      'update',
    ));
    cleanups.push(registry.registerOwnedTool(
      FILE_EDIT_TOOL_ID,
      (arguments_: Record<string, unknown>) => fileEditImpl(arguments_, fileHashStore),
      fileEditConfigSchema,
      'update',
    ));
    cleanups.push(registry.registerOwnedTool(
      GREP_TOOL_ID,
      (arguments_: Record<string, unknown>) => grepImpl(arguments_),
      grepConfigSchema,
      'read',
    ));
    cleanups.push(registry.registerOwnedTool(
      GLOB_TOOL_ID,
      (arguments_: Record<string, unknown>) => globImpl(arguments_),
      globConfigSchema,
      'read',
    ));
    cleanups.push(registry.registerOwnedTool(
      WEB_SEARCH_TOOL_ID,
      (arguments_: Record<string, unknown>) => webSearchImpl(arguments_),
      webSearchConfigSchema,
      'read',
    ));
    cleanups.push(registry.registerOwnedTool(
      LSP_TOOL_ID,
      (arguments_: Record<string, unknown>) => lspImpl(arguments_),
      lspConfigSchema,
      'read',
    ));
  } catch (error) {
    disposeOwnedToolRegistrations(cleanups);
    throw error;
  }
  return () => {
    disposeOwnedToolRegistrations(cleanups);
  };
}
