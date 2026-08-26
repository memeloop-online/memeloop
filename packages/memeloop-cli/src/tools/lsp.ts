/**
 * LSP Tool — real Language Server Protocol operations over stdio.
 *
 * Server commands are selected from a fixed language allowlist. Tool input
 * cannot choose an executable, so granting `lsp.*` never becomes a generic
 * command-execution capability.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import { MEMELOOP_CLI_VERSION } from '../version.js';

export const lspConfigSchema = z.object({
  operation: z.enum([
    'goToDefinition',
    'findReferences',
    'hover',
    'documentSymbol',
    'workspaceSymbol',
  ]),
  /** File used for document requests and language/workspace discovery. */
  filePath: z.string().min(1),
  /** One-based line number for document-position requests. */
  line: z.number().int().positive().optional(),
  /** Zero-based UTF-16 character offset, as defined by LSP. */
  character: z.number().int().min(0).optional(),
  symbolName: z.string().min(1).optional(),
  includeDeclaration: z.boolean().optional(),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
});

export const LSP_TOOL_ID = 'lsp';

interface LanguageServerSpec {
  name: string;
  command: string;
  arguments_: string[];
  languageId: string;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  params?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ExecuteLanguageServerRequest {
  server: LanguageServerSpec;
  workspaceRoot: string;
  filePath: string;
  operation: z.infer<typeof lspConfigSchema>['operation'];
  line: number;
  character: number;
  symbolName?: string;
  includeDeclaration: boolean;
  timeoutMs: number;
}

const MAX_PROTOCOL_MESSAGE_BYTES = 1024 * 1024;
const MAX_PROTOCOL_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_LENGTH = 64 * 1024;
const WORKSPACE_MARKERS = [
  '.git',
  'package.json',
  'pnpm-workspace.yaml',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'tsconfig.json',
];
const require = createRequire(import.meta.url);

function serverForFile(filePath: string): LanguageServerSpec | undefined {
  const extension = path.extname(filePath).toLowerCase();
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
    const languageId = extension === '.ts'
      ? 'typescript'
      : extension === '.tsx'
      ? 'typescriptreact'
      : extension === '.jsx'
      ? 'javascriptreact'
      : 'javascript';
    return {
      name: 'typescript-language-server',
      command: process.execPath,
      arguments_: [
        require.resolve('typescript-language-server/lib/cli.mjs'),
        '--stdio',
      ],
      languageId,
    };
  }
  if (extension === '.py') {
    return {
      name: 'pyright-langserver',
      command: 'pyright-langserver',
      arguments_: ['--stdio'],
      languageId: 'python',
    };
  }
  if (extension === '.rs') {
    return {
      name: 'rust-analyzer',
      command: 'rust-analyzer',
      arguments_: [],
      languageId: 'rust',
    };
  }
  if (extension === '.go') {
    return { name: 'gopls', command: 'gopls', arguments_: [], languageId: 'go' };
  }
  if (['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp'].includes(extension)) {
    return {
      name: 'clangd',
      command: 'clangd',
      arguments_: ['--background-index=false'],
      languageId: extension === '.c' || extension === '.h' ? 'c' : 'cpp',
    };
  }
  if (extension === '.lua') {
    return {
      name: 'lua-language-server',
      command: 'lua-language-server',
      arguments_: [],
      languageId: 'lua',
    };
  }
  return undefined;
}

function discoverWorkspaceRoot(filePath: string): string {
  let directory = path.dirname(filePath);
  while (true) {
    if (WORKSPACE_MARKERS.some((marker) => fs.existsSync(path.join(directory, marker)))) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return path.dirname(filePath);
    directory = parent;
  }
}

function boundedResult(value: unknown): string {
  const serialized = JSON.stringify(value ?? null, null, 2);
  return serialized.length > MAX_RESULT_LENGTH
    ? `${serialized.slice(0, MAX_RESULT_LENGTH)}\n... [truncated]`
    : serialized;
}

class StdioLanguageServerClient {
  private buffer = Buffer.alloc(0);
  private closed = false;
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly stderr: string[] = [];

  public constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly timeoutMs: number,
  ) {
    child.stdout.on('data', (chunk: Buffer | string) => {
      this.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      this.stderr.push(text.slice(0, 4096));
      if (this.stderr.length > 8) this.stderr.shift();
    });
    child.once('error', (error) => {
      this.closed = true;
      this.rejectAll(error);
    });
    child.once('exit', (code, signal) => {
      this.closed = true;
      this.rejectAll(
        new Error(
          `language server exited before responding (code=${String(code)}, signal=${String(signal)})${this.stderr.length > 0 ? `: ${this.stderr.join('').slice(-4096)}` : ''}`,
        ),
      );
    });
  }

  public notify(method: string, parameters: unknown): void {
    this.write({ jsonrpc: '2.0', method, params: parameters });
  }

  public request(
    method: string,
    parameters: unknown,
    timeoutMs = this.timeoutMs,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('language server is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`language server request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params: parameters });
    });
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.request('shutdown', null, Math.min(this.timeoutMs, 1000));
      this.notify('exit', null);
    } catch {
      // The operation result is already known; cleanup remains best effort.
    } finally {
      this.closed = true;
      this.child.kill('SIGTERM');
      this.rejectAll(new Error('language server client closed'));
    }
  }

  private write(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    if (body.byteLength > MAX_PROTOCOL_MESSAGE_BYTES) {
      throw new Error('language server request exceeds the protocol message bound');
    }
    this.child.stdin.write(
      Buffer.concat([
        Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'ascii'),
        body,
      ]),
    );
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.byteLength > MAX_PROTOCOL_BUFFER_BYTES) {
      this.child.kill('SIGKILL');
      this.rejectAll(new Error('language server protocol buffer exceeded its bound'));
      return;
    }
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /^Content-Length:\s*(\d+)$/im.exec(header);
      if (!match) {
        this.child.kill('SIGKILL');
        this.rejectAll(new Error('language server sent a malformed protocol header'));
        return;
      }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PROTOCOL_MESSAGE_BYTES) {
        this.child.kill('SIGKILL');
        this.rejectAll(new Error('language server response exceeds the protocol message bound'));
        return;
      }
      const bodyStart = headerEnd + 4;
      if (this.buffer.byteLength < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length);
      this.buffer = this.buffer.subarray(bodyStart + length);
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(body.toString('utf8')) as JsonRpcResponse;
      } catch {
        this.child.kill('SIGKILL');
        this.rejectAll(new Error('language server sent malformed JSON'));
        return;
      }
      this.onMessage(message);
    }
  }

  private onMessage(message: JsonRpcResponse): void {
    if (message.method && message.id !== undefined) {
      const result = message.method === 'workspace/configuration' ? [] : null;
      this.write({ jsonrpc: '2.0', id: message.id, result });
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(
        new Error(
          `language server error ${String(message.error.code ?? '')}: ${message.error.message ?? 'unknown error'}`,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function spawnLanguageServer(
  server: LanguageServerSpec,
  workspaceRoot: string,
): ChildProcessWithoutNullStreams {
  return spawn(server.command, server.arguments_, {
    cwd: workspaceRoot,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      ...(process.env.XDG_CACHE_HOME
        ? { XDG_CACHE_HOME: process.env.XDG_CACHE_HOME }
        : {}),
      NO_COLOR: '1',
    },
  });
}

/** Execute one real LSP request. Exported for protocol-level tests. */
export async function executeLanguageServerRequest(
  request: ExecuteLanguageServerRequest,
): Promise<unknown> {
  const child = spawnLanguageServer(request.server, request.workspaceRoot);
  const client = new StdioLanguageServerClient(child, request.timeoutMs);
  const fileUri = pathToFileURL(request.filePath).toString();
  const workspaceUri = pathToFileURL(request.workspaceRoot).toString();
  try {
    await client.request('initialize', {
      processId: process.pid,
      rootUri: workspaceUri,
      workspaceFolders: [{ uri: workspaceUri, name: path.basename(request.workspaceRoot) }],
      capabilities: {
        textDocument: {
          definition: {},
          references: {},
          hover: { contentFormat: ['plaintext', 'markdown'] },
          documentSymbol: {},
        },
        workspace: { symbol: {} },
      },
      clientInfo: { name: 'memeloop-cli', version: MEMELOOP_CLI_VERSION },
    });
    client.notify('initialized', {});

    if (request.operation !== 'workspaceSymbol') {
      const text = fs.readFileSync(request.filePath, 'utf8');
      client.notify('textDocument/didOpen', {
        textDocument: {
          uri: fileUri,
          languageId: request.server.languageId,
          version: 1,
          text,
        },
      });
    }

    const position = {
      line: request.line - 1,
      character: request.character,
    };
    switch (request.operation) {
      case 'goToDefinition':
        return await client.request('textDocument/definition', {
          textDocument: { uri: fileUri },
          position,
        });
      case 'findReferences':
        return await client.request('textDocument/references', {
          textDocument: { uri: fileUri },
          position,
          context: { includeDeclaration: request.includeDeclaration },
        });
      case 'hover':
        return await client.request('textDocument/hover', {
          textDocument: { uri: fileUri },
          position,
        });
      case 'documentSymbol':
        return await client.request('textDocument/documentSymbol', {
          textDocument: { uri: fileUri },
        });
      case 'workspaceSymbol':
        return await client.request('workspace/symbol', {
          query: request.symbolName ?? '',
        });
    }
  } finally {
    await client.close();
  }
}

export async function lspImpl(
  arguments_: Record<string, unknown>,
): Promise<{ result: string } | { error: string }> {
  const parsed = lspConfigSchema.safeParse(arguments_);
  if (!parsed.success) {
    return { error: `invalid_lsp_args: ${parsed.error.message}` };
  }
  const {
    operation,
    line = 1,
    character = 0,
    symbolName,
    includeDeclaration = false,
    timeoutMs = 10_000,
  } = parsed.data;
  if (operation === 'workspaceSymbol' && !symbolName) {
    return { error: 'symbolName is required for workspaceSymbol operation' };
  }

  const filePath = path.resolve(parsed.data.filePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { error: `LSP file does not exist: ${filePath}` };
  }
  if (!stat.isFile()) return { error: `LSP path is not a file: ${filePath}` };
  if (stat.size > MAX_PROTOCOL_MESSAGE_BYTES / 2) {
    return {
      error: `LSP file exceeds the ${MAX_PROTOCOL_MESSAGE_BYTES / 2} byte document bound`,
    };
  }
  const server = serverForFile(filePath);
  if (!server) {
    return {
      error: `No allowlisted language server is configured for '${path.extname(filePath) || 'extensionless files'}'`,
    };
  }

  try {
    const result = await executeLanguageServerRequest({
      server,
      workspaceRoot: discoverWorkspaceRoot(filePath),
      filePath,
      operation,
      line,
      character,
      ...(symbolName ? { symbolName } : {}),
      includeDeclaration,
      timeoutMs,
    });
    return { result: boundedResult(result) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return {
        error: `Language server '${server.name}' is not installed for ${server.languageId}`,
      };
    }
    return { error: `LSP ${operation} failed: ${message}` };
  }
}
