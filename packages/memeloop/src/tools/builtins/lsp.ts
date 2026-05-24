/**
 * LSP Tool — Language Server Protocol operations.
 *
 * Supports: goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol.
 * Uses a simple exec-based approach; real LSP integration would connect to an
 * already-running language server via stdio/socket.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { z } from "zod";

import type { BuiltinToolContext } from "./types.js";

const execFileAsync = promisify(execFile);

export const lspConfigSchema = z.object({
  operation: z.enum([
    "goToDefinition",
    "findReferences",
    "hover",
    "documentSymbol",
    "workspaceSymbol",
  ]),
  filePath: z.string().min(1),
  line: z.number().int().positive().optional(),
  character: z.number().int().min(0).optional(),
  symbolName: z.string().min(1).optional(),
  includeDeclaration: z.boolean().optional(),
});

export const LSP_TOOL_ID = "lsp";

export async function lspImpl(
  args: Record<string, unknown>,
  _ctx: BuiltinToolContext,
): Promise<{ result: string } | { error: string }> {
  const parsed = lspConfigSchema.safeParse(args);
  if (!parsed.success) {
    return { error: `invalid_lsp_args: ${parsed.error.message}` };
  }

  const { operation, filePath, line, character, symbolName, includeDeclaration } = parsed.data;

  switch (operation) {
    case "goToDefinition":
      return lspGoToDefinition(filePath, line ?? 1, character ?? 0);
    case "findReferences":
      return lspFindReferences(filePath, line ?? 1, character ?? 0, includeDeclaration ?? false);
    case "hover":
      return lspHover(filePath, line ?? 1, character ?? 0);
    case "documentSymbol":
      return lspDocumentSymbol(filePath);
    case "workspaceSymbol":
      if (!symbolName) {
        return { error: "symbolName is required for workspaceSymbol operation" };
      }
      return lspWorkspaceSymbol(symbolName);
    default:
      return { error: `unsupported LSP operation: ${operation}` };
  }
}

/**
 * Stub LSP implementation using `rg`/`grep` as a fallback.
 * TODO: Replace with real LSP integration (connect to language server via stdio/socket).
 */

async function lspGoToDefinition(
  filePath: string,
  line: number,
  character: number,
): Promise<{ result: string } | { error: string }> {
  try {
    // Stub: grep for function/class/export declarations as a best-effort fallback
    const { stdout } = await execFileAsync("rg", [
      "--line-number",
      "function |class |export |interface ",
      filePath,
    ]).catch(() => ({ stdout: "", stderr: "" }));
    return {
      result: stdout
        ? `goToDefinition stub for ${filePath}:${line}:${character}\n${stdout.slice(0, 4000)}`
        : `goToDefinition: TODO \u2014 real LSP integration needed for ${filePath}:${line}:${character}`,
    };
  } catch {
    return {
      result: `goToDefinition: TODO \u2014 real LSP integration needed for ${filePath}:${line}:${character}`,
    };
  }
}

async function lspFindReferences(
  filePath: string,
  line: number,
  character: number,
  includeDeclaration: boolean,
): Promise<{ result: string } | { error: string }> {
  try {
    const { stdout } = await execFileAsync("rg", [
      "--line-number",
      "--no-heading",
      ".",
      filePath,
    ]).catch(() => ({ stdout: "", stderr: "" }));
    const lines = stdout ? stdout.trim().split("\n").slice(0, 50) : [];
    return {
      result:
        `findReferences stub (includeDeclaration=${includeDeclaration}) for ${filePath}:${line}:${character}\n` +
        (lines.length > 0
          ? `Found ${lines.length} matching lines:\n${lines.join("\n")}`
          : "TODO \u2014 real LSP integration needed"),
    };
  } catch {
    return {
      result: `findReferences: TODO \u2014 real LSP integration needed for ${filePath}:${line}:${character}`,
    };
  }
}

async function lspHover(
  filePath: string,
  line: number,
  character: number,
): Promise<{ result: string } | { error: string }> {
  // Stub: extract the line content as "hover" info
  try {
    const { stdout } = await execFileAsync("rg", [
      "-n",
      "--max-count=1",
      "^.*$",
      filePath,
    ]).catch(() => ({ stdout: "", stderr: "" }));
    const targetLine = stdout
      ? stdout.split("\n")[line - 1]?.replace(/^\d+:/, "").trim() ?? ""
      : "";
    return {
      result:
        `hover stub at ${filePath}:${line}:${character}\n` +
        (targetLine
          ? `Line content: ${targetLine.slice(0, 500)}`
          : "TODO \u2014 real LSP integration needed"),
    };
  } catch {
    return {
      result: `hover: TODO \u2014 real LSP integration needed for ${filePath}:${line}:${character}`,
    };
  }
}

async function lspDocumentSymbol(
  filePath: string,
): Promise<{ result: string } | { error: string }> {
  // Stub: search for function/class/export/interface/const declarations
  try {
    const { stdout } = await execFileAsync("rg", [
      "--line-number",
      "function |class |interface |export |const ",
      filePath,
    ]).catch(() => ({ stdout: "", stderr: "" }));
    const symbols = stdout ? stdout.trim().split("\n").slice(0, 100) : [];
    return {
      result:
        symbols.length > 0
          ? `documentSymbol stub for ${filePath}:\n${symbols
              .map((s) => s.replace(/^\d+:/, "  L"))
              .join("\n")}`
          : `documentSymbol: TODO \u2014 real LSP integration needed for ${filePath}`,
    };
  } catch {
    return {
      result: `documentSymbol: TODO \u2014 real LSP integration needed for ${filePath}`,
    };
  }
}

async function lspWorkspaceSymbol(
  symbolName: string,
): Promise<{ result: string } | { error: string }> {
  // Stub: search for symbol across workspace using rg
  try {
    const { stdout } = await execFileAsync("rg", [
      "--line-number",
      "--no-heading",
      symbolName,
      ".",
    ]).catch(() => ({ stdout: "", stderr: "" }));
    const matches = stdout ? stdout.trim().split("\n").slice(0, 50) : [];
    return {
      result:
        matches.length > 0
          ? `workspaceSymbol stub for "${symbolName}":\n${matches.join("\n")}`
          : `workspaceSymbol: TODO \u2014 real LSP integration needed. No rg results for "${symbolName}".`,
    };
  } catch {
    return {
      result: `workspaceSymbol: TODO \u2014 real LSP integration needed for "${symbolName}"`,
    };
  }
}
