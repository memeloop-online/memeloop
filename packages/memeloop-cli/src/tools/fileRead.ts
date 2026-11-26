/**
 * fileRead.ts — Read file contents tool
 *
 * 对标 Claude Code FileReadTool
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

import { FileHashStore, recordFileRead } from './fileHashStore.js';

export const fileReadConfigSchema = z.object({
  path: z.string().min(1).describe('File path to read'),
  offset: z.number().int().min(0).optional().describe('Line offset (0-indexed)'),
  limit: z.number().int().min(1).optional().describe('Max lines to read'),
});

export const FILE_READ_TOOL_ID = 'read_file';

const MAX_FILE_SIZE = 500 * 1024; // 500KB
const MAX_LINES = 2000;

export async function fileReadImpl(
  arguments_: Record<string, unknown>,
  hashStore?: FileHashStore,
): Promise<{ result: string } | { error: string }> {
  const parsed = fileReadConfigSchema.safeParse(arguments_);
  if (!parsed.success) {
    return { error: `Invalid args: ${parsed.error.message}` };
  }

  const { path: filePath, offset = 0, limit = MAX_LINES } = parsed.data;

  try {
    const resolvedPath = resolve(filePath);
    if (!existsSync(resolvedPath)) {
      return { error: `File not found: ${filePath}` };
    }

    const stat = statSync(resolvedPath);
    if (stat.size > MAX_FILE_SIZE) {
      return { error: `File too large: ${stat.size} bytes (max ${MAX_FILE_SIZE})` };
    }

    const content = readFileSync(resolvedPath, 'utf-8');
    // Cache content hash for edit verification (read-before-edit pattern)
    if (hashStore) hashStore.recordFileRead(resolvedPath, content);
    else recordFileRead(resolvedPath, content);

    const lines = content.split('\n');

    const start = Math.min(offset, lines.length);
    const end = Math.min(start + limit, lines.length);
    const selected = lines.slice(start, end);

    // Format with line numbers
    const numbered = selected
      .map((line, index) => `${String(start + index + 1).padStart(6)}| ${line}`)
      .join('\n');

    const header = `File: ${filePath} (${lines.length} lines total, showing ${start + 1}-${end})\n`;
    return { result: header + numbered };
  } catch (error) {
    return { error: `Failed to read file: ${error instanceof Error ? error.message : String(error)}` };
  }
}
