/**
 * fileWrite.ts — Write file contents tool
 *
 * 对标 Claude Code FileWriteTool
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

export const fileWriteConfigSchema = z.object({
  path: z.string().min(1).describe('File path to write'),
  content: z.string().describe('Content to write'),
});

export const FILE_WRITE_TOOL_ID = 'write_file';

export async function fileWriteImpl(
  arguments_: Record<string, unknown>,
): Promise<{ result: string } | { error: string }> {
  const parsed = fileWriteConfigSchema.safeParse(arguments_);
  if (!parsed.success) {
    return { error: `Invalid args: ${parsed.error.message}` };
  }

  const { path: filePath, content } = parsed.data;

  try {
    const resolvedPath = resolve(filePath);
    const directory = dirname(resolvedPath);
    const existed = existsSync(resolvedPath);

    if (existed) {
      return {
        error: `File already exists: ${filePath}. ` +
          'Use edit_file (with read_file first) to modify existing files. ' +
          'write_file is only for creating new files.',
      };
    }

    // Create parent directories if needed
    mkdirSync(directory, { recursive: true });

    writeFileSync(resolvedPath, content, 'utf-8');

    const lines = content.split('\n').length;
    const size = Buffer.byteLength(content, 'utf-8');

    return {
      result: `${existed ? 'Updated' : 'Created'} file: ${filePath} (${lines} lines, ${size} bytes)`,
    };
  } catch (error) {
    return { error: `Failed to write file: ${error instanceof Error ? error.message : String(error)}` };
  }
}
