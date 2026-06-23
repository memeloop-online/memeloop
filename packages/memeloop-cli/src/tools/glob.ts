/**
 * glob.ts — File pattern matching tool
 *
 * 对标 Claude Code GlobTool
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { z } from 'zod';

export const globConfigSchema = z.object({
  pattern: z.string().min(1).describe('Glob pattern (e.g. "**/*.ts", "src/**")'),
  path: z.string().optional().describe('Search root path (default: cwd)'),
});

export const GLOB_TOOL_ID = 'glob';

export async function globImpl(
  arguments_: Record<string, unknown>,
): Promise<{ result: string } | { error: string }> {
  const parsed = globConfigSchema.safeParse(arguments_);
  if (!parsed.success) {
    return { error: `Invalid args: ${parsed.error.message}` };
  }

  const { pattern, path: searchPath = '.' } = parsed.data;

  const MAX_RESULTS = 200;

  try {
    const results = await findFiles(searchPath, pattern, MAX_RESULTS);

    if (results.length === 0) {
      return { result: `No files matching "${pattern}" found` };
    }

    const result = `Found ${results.length} files matching "${pattern}"` +
      (results.length >= MAX_RESULTS ? ` (limited to ${MAX_RESULTS})` : '') +
      '\n' + results.join('\n');

    return { result };
  } catch (error) {
    return { error: `Glob error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function findFiles(
  root: string,
  pattern: string,
  maxResults: number,
): Promise<string[]> {
  return new Promise((resolvePromise) => {
    const baseDirectory = resolve(root);
    if (!existsSync(baseDirectory)) {
      resolvePromise([]);
      return;
    }

    const results: string[] = [];
    const parts = pattern.split('/');
    const isRecursive = parts[0] === '**';
    const filePattern = isRecursive ? parts.slice(1).join('/') : pattern;

    // Simple glob: support **/*.ext patterns
    const extensionMatch = filePattern.match(/^\*\.(\w+)$/);
    const isAllFiles = pattern === '**/*' || pattern === '*';

    function walk(directory: string, depth: number) {
      if (results.length >= maxResults) return;

      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (results.length >= maxResults) return;

        const fullPath = join(directory, entry.name);
        const relativePath = relative(baseDirectory, fullPath);

        if (entry.isDirectory()) {
          // Skip hidden dirs and node_modules
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          if (isRecursive && depth < 20) {
            walk(fullPath, depth + 1);
          }
        } else if (entry.isFile()) {
          if (isAllFiles || (extensionMatch && entry.name.endsWith(`.${extensionMatch[1]}`))) {
            results.push(relativePath);
          } else if (minimatch(entry.name, filePattern)) {
            results.push(relativePath);
          }
        }
      }
    }

    walk(baseDirectory, 0);
    resolvePromise(results);
  });
}

/**
 * Minimal glob matcher — supports * and ? wildcards.
 */
function minimatch(name: string, pattern: string): boolean {
  // Convert glob to regex: * → .*, ? → ., escape rest
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regex}$`).test(name);
}
