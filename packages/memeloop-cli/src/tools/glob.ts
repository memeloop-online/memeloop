/**
 * glob.ts — File pattern matching tool
 *
 * 对标 Claude Code GlobTool
 */
import { readdirSync, existsSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { z } from "zod";


export const globConfigSchema = z.object({
  pattern: z.string().min(1).describe('Glob pattern (e.g. "**/*.ts", "src/**")'),
  path: z.string().optional().describe("Search root path (default: cwd)"),
});

export const GLOB_TOOL_ID = "glob";

export async function globImpl(
  args: Record<string, unknown>,
  
): Promise<{ result: string } | { error: string }> {
  const parsed = globConfigSchema.safeParse(args);
  if (!parsed.success) {
    return { error: `Invalid args: ${parsed.error.message}` };
  }

  const { pattern, path: searchPath = "." } = parsed.data;

  const MAX_RESULTS = 200;

  try {
    const results = await findFiles(searchPath, pattern, MAX_RESULTS);

    if (results.length === 0) {
      return { result: `No files matching "${pattern}" found` };
    }

    const result = `Found ${results.length} files matching "${pattern}"` +
      (results.length >= MAX_RESULTS ? ` (limited to ${MAX_RESULTS})` : "") +
      "\n" + results.join("\n");

    return { result };
  } catch (err) {
    return { error: `Glob error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function findFiles(
  root: string,
  pattern: string,
  maxResults: number,
): Promise<string[]> {
  return new Promise((resolvePromise) => {
    const baseDir = resolve(root);
    if (!existsSync(baseDir)) {
      resolvePromise([]);
      return;
    }

    const results: string[] = [];
    const parts = pattern.split("/");
    const isRecursive = parts[0] === "**";
    const filePattern = isRecursive ? parts.slice(1).join("/") : pattern;

    // Simple glob: support **/*.ext patterns
    const extMatch = filePattern.match(/^\*\.(\w+)$/);
    const isAllFiles = pattern === "**/*" || pattern === "*";

    function walk(dir: string, depth: number) {
      if (results.length >= maxResults) return;

      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (results.length >= maxResults) return;

        const fullPath = join(dir, entry.name);
        const relPath = relative(baseDir, fullPath);

        if (entry.isDirectory()) {
          // Skip hidden dirs and node_modules
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          if (isRecursive && depth < 20) {
            walk(fullPath, depth + 1);
          }
        } else if (entry.isFile()) {
          if (isAllFiles || (extMatch && entry.name.endsWith(`.${extMatch[1]}`))) {
            results.push(relPath);
          } else if (minimatch(entry.name, filePattern)) {
            results.push(relPath);
          }
        }
      }
    }

    walk(baseDir, 0);
    resolvePromise(results);
  });
}

/**
 * Minimal glob matcher — supports * and ? wildcards.
 */
function minimatch(name: string, pattern: string): boolean {
  // Convert glob to regex: * → .*, ? → ., escape rest
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regex}$`).test(name);
}
