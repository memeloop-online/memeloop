/**
 * File system tools: read, write, list dir, ripgrep search, tail (last N lines).
 *
 * Node.js-specific — registered into memeloop's IToolRegistry framework
 * by registerNodeEnvironmentTools. RPC helpers (runFile*Rpc) are dynamically
 * imported by rpcHandlers.ts for memeloop.file.* JSON-RPC methods.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { buildMemeloopFileUri } from "@memeloop/protocol";

import type { IToolRegistry } from "memeloop";
import { MEMELOOP_STRUCTURED_TOOL_KEY } from "memeloop";

const FILE_READ_ID = "file.read";
const FILE_WRITE_ID = "file.write";
const FILE_LIST_ID = "file.list";
const FILE_SEARCH_ID = "file.search";
const FILE_TAIL_ID = "file.tail";

export interface RegisterFileToolsOptions {
  nodeId?: string;
}

export function registerFileTools(
  registry: IToolRegistry,
  baseDir?: string,
  options?: RegisterFileToolsOptions,
): void {
  const root = baseDir ?? process.cwd();
  const nodeId = options?.nodeId ?? "local";

  registry.registerTool(FILE_READ_ID, (args: Record<string, unknown>) => readImpl(args, root, nodeId));
  registry.registerTool(FILE_WRITE_ID, (args: Record<string, unknown>) => writeImpl(args, root));
  registry.registerTool(FILE_LIST_ID, (args: Record<string, unknown>) => listImpl(args, root));
  registry.registerTool(FILE_SEARCH_ID, (args: Record<string, unknown>) => searchImpl(args, root));
  registry.registerTool(FILE_TAIL_ID, (args: Record<string, unknown>) => tailImpl(args, root));
}

function resolvePath(p: string, root: string): string {
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(rootResolved, p);
  const relative = path.relative(rootResolved, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path escapes base directory");
  }
  return resolved;
}

function fileReadSummary(relPath: string, byteLength: number, fileUri: string): string {
  return `file.read ${relPath} (${byteLength} bytes). Full content: ${fileUri}`;
}

async function readImpl(
  args: Record<string, unknown>,
  root: string,
  nodeId: string,
): Promise<unknown> {
  const p = args.path as string | undefined;
  const encoding = (args.encoding as string) ?? "utf-8";
  if (!p || typeof p !== "string") {
    return { error: "Missing 'path'. Example: { path: 'src/index.ts', encoding?: 'utf-8' }" };
  }
  try {
    const full = resolvePath(p, root);
    const content = await fs.promises.readFile(full, encoding as BufferEncoding);
    const fileUri = buildMemeloopFileUri(nodeId, p);
    const byteLength = Buffer.byteLength(content, encoding === "utf-8" ? "utf8" : "utf8");
    return {
      path: p,
      encoding,
      byteLength,
      [MEMELOOP_STRUCTURED_TOOL_KEY]: {
        summary: fileReadSummary(p, byteLength, fileUri),
        detailRef: {
          type: "file" as const,
          fileUri,
          nodeId,
        },
      },
    };
  } catch (e) {
    return { error: String(e) };
  }
}

async function writeImpl(
  args: Record<string, unknown>,
  root: string,
): Promise<unknown> {
  const p = args.path as string | undefined;
  const content = args.content as string | undefined;
  if (!p || typeof p !== "string") {
    return { error: "Missing 'path'. Example: { path: 'out.txt', content: '...' }" };
  }
  if (typeof content !== "string") {
    return { error: "Missing or invalid 'content' (string)." };
  }
  try {
    const full = resolvePath(p, root);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, content, "utf-8");
    return { path: full, ok: true };
  } catch (e) {
    return { error: String(e) };
  }
}

async function listImpl(
  args: Record<string, unknown>,
  root: string,
): Promise<unknown> {
  const p = (args.path as string) ?? ".";
  const recursive = Boolean(args.recursive);
  try {
    const full = resolvePath(p, root);
    const stat = await fs.promises.stat(full);
    if (!stat.isDirectory()) {
      return { error: "Not a directory", path: full };
    }
    const entries: { name: string; type: "file" | "dir"; size?: number }[] = [];
    const items = await fs.promises.readdir(full, { withFileTypes: true });
    for (const d of items) {
      const name = d.name;
      if (d.isDirectory()) {
        entries.push({ name, type: "dir" });
        if (recursive) {
          const sub = await listImpl({ path: path.join(p, name), recursive: true }, root) as { entries?: typeof entries };
          if (sub.entries) {
            for (const e of sub.entries) {
              entries.push({ ...e, name: path.join(name, e.name) });
            }
          }
        }
      } else {
        const stat = await fs.promises.stat(path.join(full, name));
        entries.push({ name, type: "file", size: stat.size });
      }
    }
    return { path: full, entries };
  } catch (e) {
    return { error: String(e) };
  }
}

async function searchImpl(
  args: Record<string, unknown>,
  root: string,
): Promise<unknown> {
  const pattern = args.pattern as string | undefined;
  const dir = (args.path as string) ?? ".";
  if (!pattern || typeof pattern !== "string") {
    return { error: "Missing 'pattern'. Example: { pattern: 'function', path?: '.' }" };
  }
  try {
    const full = resolvePath(dir, root);
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const proc = spawn("rg", [pattern, "--line-number", "--no-heading", "."], {
        cwd: full,
        windowsHide: true,
      });
      let out = "";
      let err = "";
      proc.stdout?.on("data", (d) => { out += d.toString(); });
      proc.stderr?.on("data", (d) => { err += d.toString(); });
      proc.on("close", (code) => {
        if (code === 0 || code === 1) resolve({ stdout: out, stderr: err });
        else reject(new Error(`rg exited ${code}: ${err}`));
      });
      proc.on("error", reject);
    });
    const lines = result.stdout.trim() ? result.stdout.trim().split("\n") : [];
    return { pattern, path: full, matches: lines, count: lines.length };
  } catch (e) {
    return { error: String(e), hint: "Ensure ripgrep (rg) is installed and in PATH." };
  }
}

async function tailImpl(
  args: Record<string, unknown>,
  root: string,
): Promise<unknown> {
  const p = args.path as string | undefined;
  const lines = (args.lines as number) ?? 50;
  if (!p || typeof p !== "string") {
    return { error: "Missing 'path'. Example: { path: 'app.log', lines?: 50 }" };
  }
  try {
    const full = resolvePath(p, root);
    const content = await fs.promises.readFile(full, "utf-8");
    const all = content.split("\n");
    const last = all.slice(-Math.max(1, lines));
    return { path: full, lines: last, totalLines: all.length };
  } catch (e) {
    return { error: String(e) };
  }
}

// --- RPC helpers (dynamically imported by rpcHandlers.ts for memeloop.file.* JSON-RPC) ---

export function runFileReadRpc(
  args: Record<string, unknown>,
  root: string,
  nodeId: string = "local",
): Promise<unknown> {
  return Promise.resolve(readImpl(args, root, nodeId));
}
export function runFileWriteRpc(args: Record<string, unknown>, root: string): Promise<unknown> {
  return Promise.resolve(writeImpl(args, root));
}
export function runFileListRpc(args: Record<string, unknown>, root: string): Promise<unknown> {
  return Promise.resolve(listImpl(args, root));
}
export function runFileSearchRpc(args: Record<string, unknown>, root: string): Promise<unknown> {
  return Promise.resolve(searchImpl(args, root));
}
export function runFileTailRpc(args: Record<string, unknown>, root: string): Promise<unknown> {
  return Promise.resolve(tailImpl(args, root));
}
