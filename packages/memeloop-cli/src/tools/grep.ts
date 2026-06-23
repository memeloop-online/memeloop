/**
 * grep.ts — Text search tool (rg/grep wrapper)
 *
 * 对标 Claude Code GrepTool
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

export const grepConfigSchema = z.object({
  pattern: z.string().min(1).describe('Regex or literal search pattern'),
  path: z.string().optional().describe('Search path (default: cwd)'),
  include: z.string().optional().describe('File glob pattern (e.g. *.ts)'),
  maxResults: z.number().int().min(1).max(200).optional().default(50),
});

export const GREP_TOOL_ID = 'grep';

export async function grepImpl(
  arguments_: Record<string, unknown>,
): Promise<{ result: string } | { error: string }> {
  const parsed = grepConfigSchema.safeParse(arguments_);
  if (!parsed.success) {
    return { error: `Invalid args: ${parsed.error.message}` };
  }

  const { pattern, path: searchPath, include, maxResults } = parsed.data;

  try {
    // Try rg (ripgrep) first, fall back to grep
    const useRg = await isCommandAvailable('rg');

    const cmdArguments: string[] = [];

    if (useRg) {
      cmdArguments.push('--line-number', '--no-heading', '--color=never');
      cmdArguments.push('-m', String(maxResults));
      if (include) {
        cmdArguments.push('--glob', include);
      }
      cmdArguments.push(pattern);
      if (searchPath) cmdArguments.push(searchPath);
    } else {
      cmdArguments.push('-rn', '--color=never');
      cmdArguments.push('-m', String(maxResults));
      if (include) {
        cmdArguments.push('--include', include);
      }
      cmdArguments.push(pattern);
      if (searchPath) cmdArguments.push(searchPath);
      else cmdArguments.push('.');
    }

    const cmd = useRg ? 'rg' : 'grep';
    const { stdout } = await execFileAsync(cmd, cmdArguments, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    });

    const lines = stdout.trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      return { result: `No matches found for "${pattern}"` };
    }

    const truncated = lines.slice(0, maxResults);
    const result = `Found ${lines.length} matches for "${pattern}"` +
      (lines.length > maxResults ? ` (showing first ${maxResults})` : '') +
      '\n' + truncated.join('\n');

    return { result };
  } catch (error: unknown) {
    const ex = error as { code?: string; stderr?: string; message?: string };
    if (ex.code === 'ENOENT') {
      return { error: 'Neither rg nor grep is available. Install ripgrep (recommended) or grep.' };
    }
    // Exit code 1 from grep means "no matches" — not an error
    if ((ex as { code?: string }).code === 'ENOENT' || ex.stderr?.includes('No such file')) {
      return { error: `Search failed: ${ex.message}` };
    }
    if ((ex as { code?: number }).code === 1) {
      return { result: `No matches found for "${pattern}"` };
    }
    return { error: `Search error: ${ex.message}` };
  }
}

async function isCommandAvailable(cmd: string): Promise<boolean> {
  try {
    await execFileAsync('which', [cmd]);
    return true;
  } catch {
    return false;
  }
}
