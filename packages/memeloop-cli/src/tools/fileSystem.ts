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

import { MEMELOOP_STRUCTURED_TOOL_KEY } from 'memeloop';
import { disposeOwnedToolRegistrations, type OwnedToolRegistry } from './ownedToolRegistry.js';

const FILE_READ_ID = 'file.read';
const FILE_WRITE_ID = 'file.write';
const FILE_LIST_ID = 'file.list';
const FILE_SEARCH_ID = 'file.search';
const FILE_TAIL_ID = 'file.tail';

/**
 * File tools are model-facing APIs. Keep every result and intermediate buffer
 * bounded even when a caller points them at a generated/vendor tree.
 */
const FILE_TOOL_LIMITS = Object.freeze(
  {
    listEntries: 10_000,
    listDepth: 64,
    searchOutputBytes: 2 * 1024 * 1024,
    searchMatches: 10_000,
    tailLineCharacters: 1 * 1024 * 1024,
    tailOutputBytes: 4 * 1024 * 1024,
    tailLines: 10_000,
    writeBytes: 16 * 1024 * 1024,
  } as const,
);

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
      lines: { type: 'integer', minimum: 1, maximum: FILE_TOOL_LIMITS.tailLines },
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
  registry: OwnedToolRegistry,
  baseDirectory: string | undefined,
  options: RegisterFileToolsOptions,
): () => void {
  const root = baseDirectory ?? process.cwd();
  const nodeId = options.nodeId.trim();
  if (!nodeId) throw new Error('registerFileTools requires a stable nodeId');

  const cleanups: Array<() => boolean> = [];
  try {
    cleanups.push(registry.registerOwnedTool(
      FILE_READ_ID,
      (arguments_: Record<string, unknown>) => readImpl(arguments_, root, nodeId),
      fileToolSchemas[FILE_READ_ID],
      'read',
    ));
    cleanups.push(registry.registerOwnedTool(
      FILE_WRITE_ID,
      (arguments_: Record<string, unknown>) => writeImpl(arguments_, root),
      fileToolSchemas[FILE_WRITE_ID],
      'update',
    ));
    cleanups.push(registry.registerOwnedTool(
      FILE_LIST_ID,
      (arguments_: Record<string, unknown>) => listImpl(arguments_, root),
      fileToolSchemas[FILE_LIST_ID],
      'read',
    ));
    cleanups.push(registry.registerOwnedTool(
      FILE_SEARCH_ID,
      (arguments_: Record<string, unknown>) => searchImpl(arguments_, root),
      fileToolSchemas[FILE_SEARCH_ID],
      'read',
    ));
    cleanups.push(registry.registerOwnedTool(
      FILE_TAIL_ID,
      (arguments_: Record<string, unknown>) => tailImpl(arguments_, root),
      fileToolSchemas[FILE_TAIL_ID],
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
    const stat = await fs.promises.stat(full);
    if (!stat.isFile()) return { error: 'Not a file', path: full };
    // `file.read` returns a bounded summary and a URI for on-demand detail;
    // never load the entire file merely to calculate its size.
    const fileUri = buildMemeloopFileUri(nodeId, p);
    const byteLength = stat.size;
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
  if (Buffer.byteLength(content, 'utf8') > FILE_TOOL_LIMITS.writeBytes) {
    return { error: `Content exceeds ${FILE_TOOL_LIMITS.writeBytes} byte limit.` };
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
    await collectDirectoryEntries(full, p, recursive, entries, 0);
    return { path: full, entries };
  } catch (error) {
    return { error: String(error) };
  }
}

async function collectDirectoryEntries(
  directoryPath: string,
  relativePath: string,
  recursive: boolean,
  entries: { name: string; type: 'file' | 'dir'; size?: number }[],
  depth: number,
): Promise<void> {
  if (depth > FILE_TOOL_LIMITS.listDepth) {
    throw new Error(`Directory depth exceeds ${FILE_TOOL_LIMITS.listDepth}.`);
  }
  const directory = await fs.promises.opendir(directoryPath);
  for await (const entry of directory) {
    if (entries.length >= FILE_TOOL_LIMITS.listEntries) {
      throw new Error(`Directory entry count exceeds ${FILE_TOOL_LIMITS.listEntries}.`);
    }
    const name = path.join(relativePath, entry.name);
    if (entry.isDirectory()) {
      entries.push({ name, type: 'dir' });
      if (recursive) {
        await collectDirectoryEntries(path.join(directoryPath, entry.name), name, true, entries, depth + 1);
      }
    } else if (entry.isFile()) {
      const stat = await fs.promises.stat(path.join(directoryPath, entry.name));
      entries.push({ name, type: 'file', size: stat.size });
    }
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
      let overflow = false;
      let outputBytes = 0;
      const append = (current: string, chunk: Buffer): string => {
        const text = chunk.toString();
        const chunkBytes = Buffer.byteLength(text, 'utf8');
        if (outputBytes + chunkBytes > FILE_TOOL_LIMITS.searchOutputBytes) {
          overflow = true;
          proc.kill('SIGTERM');
          return current;
        }
        outputBytes += chunkBytes;
        return current + text;
      };
      proc.stdout?.on('data', (d: Buffer) => {
        out = append(out, d);
      });
      proc.stderr?.on('data', (d: Buffer) => {
        error = append(error, d);
      });
      proc.on('close', (code) => {
        if (overflow) {
          reject(new Error(`Search output exceeds ${FILE_TOOL_LIMITS.searchOutputBytes} byte limit.`));
          return;
        }
        if (code === 0 || code === 1) resolve({ stdout: out, stderr: error });
        else reject(new Error(`rg exited ${code}: ${error}`));
      });
      proc.on('error', reject);
    });
    const lines = result.stdout.trim() ? result.stdout.trim().split('\n') : [];
    if (lines.length > FILE_TOOL_LIMITS.searchMatches) {
      return { error: `Search match count exceeds ${FILE_TOOL_LIMITS.searchMatches} limit.` };
    }
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
    if (!Number.isSafeInteger(lines) || lines < 1 || lines > FILE_TOOL_LIMITS.tailLines) {
      return { error: `lines must be an integer between 1 and ${FILE_TOOL_LIMITS.tailLines}.` };
    }
    const stat = await fs.promises.stat(full);
    if (!stat.isFile()) return { error: 'Not a file', path: full };
    const tail = await readTailLines(full, lines);
    return { path: full, lines: tail.lines, totalLines: tail.totalLines };
  } catch (error) {
    return { error: String(error) };
  }
}

async function readTailLines(filePath: string, requestedLines: number): Promise<{ lines: string[]; totalLines: number }> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines: string[] = [];
  let pending = '';
  let totalLines = 0;
  let retainedBytes = 0;
  const pushLine = (line: string): void => {
    lines.push(line);
    retainedBytes += Buffer.byteLength(line, 'utf8');
    if (lines.length > requestedLines) {
      const removed = lines.shift();
      if (removed !== undefined) retainedBytes -= Buffer.byteLength(removed, 'utf8');
    }
    if (retainedBytes > FILE_TOOL_LIMITS.tailOutputBytes) {
      throw new Error(`Tail output exceeds ${FILE_TOOL_LIMITS.tailOutputBytes} byte limit.`);
    }
  };
  for await (const chunk of stream) {
    pending += String(chunk);
    if (pending.length > FILE_TOOL_LIMITS.tailLineCharacters) {
      throw new Error(`Line exceeds ${FILE_TOOL_LIMITS.tailLineCharacters} character limit.`);
    }
    const complete = pending.split('\n');
    pending = complete.pop() ?? '';
    for (const line of complete) {
      pushLine(line);
      totalLines += 1;
    }
  }
  // `String.split('\n')` (the historical implementation) exposes a trailing
  // empty item when the file ends in a newline; preserve that contract while
  // retaining only the requested tail window.
  pushLine(pending);
  totalLines += 1;
  return { lines, totalLines };
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
