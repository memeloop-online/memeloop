/**
 * VSCode CLI tools: open file/folder, run code --cli, list extensions (diagnostics via runCli).
 */

import { spawn } from 'node:child_process';

import { disposeOwnedToolRegistrations, type OwnedToolRegistry } from './ownedToolRegistry.js';

const VSCODE_OPEN_ID = 'vscode.open';
const VSCODE_OPEN_FOLDER_ID = 'vscode.openFolder';
const VSCODE_RUN_CLI_ID = 'vscode.runCli';
const VSCODE_LIST_EXT_ID = 'vscode.listExtensions';

const vscodePathSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1 },
  },
  required: ['path'],
  additionalProperties: false,
} as const;

export const vscodeToolSchemas = {
  [VSCODE_OPEN_ID]: vscodePathSchema,
  [VSCODE_OPEN_FOLDER_ID]: vscodePathSchema,
  [VSCODE_RUN_CLI_ID]: {
    type: 'object',
    properties: {
      command: { type: 'string', minLength: 1 },
      args: { type: 'array', items: { type: 'string' }, maxItems: 100 },
    },
    required: ['command'],
    additionalProperties: false,
  },
  [VSCODE_LIST_EXT_ID]: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
} as const;

function runCode(arguments_: string[], timeoutMs = 15_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn('code', arguments_, { shell: true });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const t = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ stdout, stderr, code: null });
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(t);
      resolve({ stdout, stderr, code });
    });
    proc.on('error', (error) => {
      clearTimeout(t);
      resolve({ stdout, stderr: error.message, code: -1 });
    });
  });
}

export function registerVscodeTools(registry: OwnedToolRegistry): () => void {
  const cleanups: Array<() => boolean> = [];
  try {
    cleanups.push(registry.registerOwnedTool(
      VSCODE_OPEN_ID,
      async (arguments_: Record<string, unknown>) => {
        const path = arguments_.path as string | undefined;
        if (!path || typeof path !== 'string') {
          return { error: "Missing 'path'. Example: { path: 'src/index.ts' }" };
        }
        const result = await runCode(['--reuse-window', path]);
        return { path, ...result };
      },
      vscodeToolSchemas[VSCODE_OPEN_ID],
      'execute',
    ));
    cleanups.push(registry.registerOwnedTool(
      VSCODE_OPEN_FOLDER_ID,
      async (arguments_: Record<string, unknown>) => {
        const path = arguments_.path as string | undefined;
        if (!path || typeof path !== 'string') {
          return { error: "Missing 'path'. Example: { path: '/projects/myapp' }" };
        }
        const result = await runCode(['--reuse-window', path]);
        return { path, ...result };
      },
      vscodeToolSchemas[VSCODE_OPEN_FOLDER_ID],
      'execute',
    ));
    cleanups.push(registry.registerOwnedTool(
      VSCODE_RUN_CLI_ID,
      async (arguments_: Record<string, unknown>) => {
        const cmd = arguments_.command as string | undefined;
        const cmdArguments = (arguments_.args as string[]) ?? [];
        if (!cmd || typeof cmd !== 'string') {
          return {
            error: "Missing 'command'. Example: { command: 'workbench.action.problems.focus', args?: [] }",
          };
        }
        const allArguments = ['--cli', cmd, ...cmdArguments];
        const result = await runCode(allArguments);
        return { command: cmd, ...result };
      },
      vscodeToolSchemas[VSCODE_RUN_CLI_ID],
      'execute',
    ));
    cleanups.push(registry.registerOwnedTool(
      VSCODE_LIST_EXT_ID,
      async () => {
        const result = await runCode(['--list-extensions']);
        const list = result.stdout.trim() ? result.stdout.trim().split(/\r?\n/) : [];
        return { extensions: list, ...result };
      },
      vscodeToolSchemas[VSCODE_LIST_EXT_ID],
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
