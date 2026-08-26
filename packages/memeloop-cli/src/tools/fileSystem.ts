/**
 * File system tools: read, write, list dir, ripgrep search, tail (last N lines).
 *
 * Node.js-specific — registered into memeloop's IToolRegistry framework
 * by registerNodeEnvironmentTools. RPC helpers (runFile*Rpc) are dynamically
 * imported by rpcHandlers.ts for memeloop.file.* JSON-RPC methods.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { buildMemeloopFileUri } from 'memeloop';

import type { IToolRegistry } from 'memeloop';
import { MEMELOOP_STRUCTURED_TOOL_KEY } from 'memeloop';

const FILE_READ_ID = 'file.read';
const FILE_WRITE_ID = 'file.write';
const FILE_LIST_ID = 'file.list';
const FILE_SEARCH_ID = 'file.search';
const FILE_TAIL_ID = 'file.tail';

const pathProperty = {
  type: 'string',
  minLength: 1,
  description: 'Path relative to the configured file-tool root',
} as const;

export const fileToolSchemas = {
  [FILE_READ_ID]: {
    type: 'object',
    properties: {
      path: pathProperty,
      encoding: { type: 'string', enum: ['utf-8'] },
    },
    required: ['path'],
    additionalProperties: false,
  },
  [FILE_WRITE_ID]: {
    type: 'object',
    properties: {
      path: pathProperty,
      content: { type: 'string' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  [FILE_LIST_ID]: {
    type: 'object',
    properties: {
      path: pathProperty,
      recursive: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  [FILE_SEARCH_ID]: {
    type: 'object',
    properties: {
      pattern: { type: 'string', minLength: 1 },
      path: pathProperty,
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  [FILE_TAIL_ID]: {
    type: 'object',
    properties: {
      path: pathProperty,
      lines: { type: 'integer', minimum: 1, maximum: 10_000 },
    },
    required: ['path'],
    additionalProperties: false,
  },
} as const;

export interface RegisterFileToolsOptions {
  /** Stable, globally unique identity used in cross-device detail references. */
  nodeId: string;
}

export function registerFileTools(
  registry: IToolRegistry,
  baseDirectory: string | undefined,
  options: RegisterFileToolsOptions,
): void {
  const root = baseDirectory ?? process.cwd();
  const nodeId = options.nodeId.trim();
  if (!nodeId) throw new Error('registerFileTools requires a stable nodeId');

  registry.registerTool(
    FILE_READ_ID,
    (arguments_: Record<string, unknown>) => readImpl(arguments_, root, nodeId),
    fileToolSchemas[FILE_READ_ID],
    'read',
  );
  registry.registerTool(
    FILE_WRITE_ID,
    (arguments_: Record<string, unknown>) => writeImpl(arguments_, root),
    fileToolSchemas[FILE_WRITE_ID],
    'update',
  );
  registry.registerTool(
    FILE_LIST_ID,
    (arguments_: Record<string, unknown>) => listImpl(arguments_, root),
    fileToolSchemas[FILE_LIST_ID],
    'read',
  );
  registry.registerTool(
    FILE_SEARCH_ID,
    (arguments_: Record<string, unknown>) => searchImpl(arguments_, root),
    fileToolSchemas[FILE_SEARCH_ID],
    'read',
  );
  registry.registerTool(
    FILE_TAIL_ID,
    (arguments_: Record<string, unknown>) => tailImpl(arguments_, root),
    fileToolSchemas[FILE_TAIL_ID],
    'read',
  );
}

function resolvePath(p: string, root: string): string {
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(rootResolved, p);
  const relative = path.relative(rootResolved, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path escapes base directory');
  }
  return resolved;
}

function fileReadSummary(relativePath: string, byteLength: number, fileUri: string): string {
  return `file.read ${relativePath} (${byteLength} bytes). Full content: ${fileUri}`;
}

async function readImpl(
  arguments_: Record<string, unknown>,
  root: string,
  nodeId: string,
): Promise<unknown> {
  const p = arguments_.path as string | undefined;
  const encoding = (arguments_.encoding as string) ?? 'utf-8';
  if (!p || typeof p !== 'string') {
    return { error: "Missing 'path'. Example: { path: 'src/index.ts', encoding?: 'utf-8' }" };
  }
  try {
    const full = resolvePath(p, root);
    const content = await fs.promises.readFile(full, encoding as BufferEncoding);
    const fileUri = (buildMemeloopFileUri as (nodeId: string, path: string) => string)(nodeId, p);
    const byteLength = Buffer.byteLength(content, encoding === 'utf-8' ? 'utf8' : 'utf8');
    return {
      path: p,
      encoding,
      byteLength,
      [MEMELOOP_STRUCTURED_TOOL_KEY]: {
        summary: fileReadSummary(p, byteLength, fileUri),
        detailRef: {
          type: 'file' as const,
          fileUri,
          nodeId,
        },
      },
    };
  } catch (error) {
    return { error: String(error) };
  }
}

async function writeImpl(
  arguments_: Record<string, unknown>,
  root: string,
): Promise<unknown> {
  const p = arguments_.path as string | undefined;
  const content = arguments_.content as string | undefined;
  if (!p || typeof p !== 'string') {
    return { error: "Missing 'path'. Example: { path: 'out.txt', content: '...' }" };
  }
  if (typeof content !== 'string') {
    return { error: "Missing or invalid 'content' (string)." };
  }
  try {
    const full = resolvePath(p, root);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, content, 'utf-8');
    return { path: full, ok: true };
  } catch (error) {
    return { error: String(error) };
  }
}

async function listImpl(
  arguments_: Record<string, unknown>,
  root: string,
): Promise<unknown> {
  const p = (arguments_.path as string) ?? '.';
  const recursive = Boolean(arguments_.recursive);
  try {
    const full = resolvePath(p, root);
    const stat = await fs.promises.stat(full);
    if (!stat.isDirectory()) {
      return { error: 'Not a directory', path: full };
    }
    const entries: { name: string; type: 'file' | 'dir'; size?: number }[] = [];
    const items = await fs.promises.readdir(full, { withFileTypes: true });
    for (const d of items) {
      const name = d.name;
      if (d.isDirectory()) {
        entries.push({ name, type: 'dir' });
        if (recursive) {
          const sub = await listImpl({ path: path.join(p, name), recursive: true }, root) as { entries?: typeof entries };
          if (sub.entries) {
            for (const subEntry of sub.entries) {
              entries.push({ ...subEntry, name: path.join(name, subEntry.name) });
            }
          }
        }
      } else {
        const stat = await fs.promises.stat(path.join(full, name));
        entries.push({ name, type: 'file', size: stat.size });
      }
    }
    return { path: full, entries };
  } catch (error) {
    return { error: String(error) };
  }
}

async function searchImpl(
  arguments_: Record<string, unknown>,
  root: string,
): Promise<unknown> {
  const pattern = arguments_.pattern as string | undefined;
  const directory = (arguments_.path as string) ?? '.';
  if (!pattern || typeof pattern !== 'string') {
    return { error: "Missing 'pattern'. Example: { pattern: 'function', path?: '.' }" };
  }
  try {
    const full = resolvePath(directory, root);
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const proc = spawn('rg', [pattern, '--line-number', '--no-heading', '.'], {
        cwd: full,
        windowsHide: true,
      });
      let out = '';
      let error = '';
      proc.stdout?.on('data', (d: Buffer) => {
        out += d.toString();
      });
      proc.stderr?.on('data', (d: Buffer) => {
        error += d.toString();
      });
      proc.on('close', (code) => {
        if (code === 0 || code === 1) resolve({ stdout: out, stderr: error });
        else reject(new Error(`rg exited ${code}: ${error}`));
      });
      proc.on('error', reject);
    });
    const lines = result.stdout.trim() ? result.stdout.trim().split('\n') : [];
    return { pattern, path: full, matches: lines, count: lines.length };
  } catch (error) {
    return { error: String(error), hint: 'Ensure ripgrep (rg) is installed and in PATH.' };
  }
}

async function tailImpl(
  arguments_: Record<string, unknown>,
  root: string,
): Promise<unknown> {
  const p = arguments_.path as string | undefined;
  const lines = (arguments_.lines as number) ?? 50;
  if (!p || typeof p !== 'string') {
    return { error: "Missing 'path'. Example: { path: 'app.log', lines?: 50 }" };
  }
  try {
    const full = resolvePath(p, root);
    const content = await fs.promises.readFile(full, 'utf-8');
    const all = content.split('\n');
    const last = all.slice(-Math.max(1, lines));
    return { path: full, lines: last, totalLines: all.length };
  } catch (error) {
    return { error: String(error) };
  }
}

// --- RPC helpers (dynamically imported by rpcHandlers.ts for memeloop.file.* JSON-RPC) ---

export function runFileReadRpc(
  arguments_: Record<string, unknown>,
  root: string,
  nodeId: string,
): Promise<unknown> {
  if (!nodeId.trim()) throw new Error('runFileReadRpc requires a stable nodeId');
  return Promise.resolve(readImpl(arguments_, root, nodeId));
}
export function runFileWriteRpc(arguments_: Record<string, unknown>, root: string): Promise<unknown> {
  return Promise.resolve(writeImpl(arguments_, root));
}
export function runFileListRpc(arguments_: Record<string, unknown>, root: string): Promise<unknown> {
  return Promise.resolve(listImpl(arguments_, root));
}
export function runFileSearchRpc(arguments_: Record<string, unknown>, root: string): Promise<unknown> {
  return Promise.resolve(searchImpl(arguments_, root));
}
export function runFileTailRpc(arguments_: Record<string, unknown>, root: string): Promise<unknown> {
  return Promise.resolve(tailImpl(arguments_, root));
}
