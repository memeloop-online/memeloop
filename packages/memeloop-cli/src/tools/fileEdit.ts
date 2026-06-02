/**
 * fileEdit.ts — Hash Edit: search-and-replace with read-before-edit enforcement
 *
 * 对标 Claude Code FileEditTool + OpenCode apply_patch:
 * - 必须先 read_file 才能 edit_file（read 时缓存 SHA256 hash）
 * - old_string 必须精确匹配（hash 校验确保文件未被外部修改）
 * - 支持 replace_all 批量替换
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

import { verifyReadHash, getReadHash } from "./fileHashStore.js";

export const fileEditConfigSchema = z.object({
  path: z.string().min(1).describe("File path to edit (must have been read first via read_file)"),
  oldString: z.string().min(1).describe("Exact text to replace (must match file content precisely)"),
  newString: z.string().describe("Replacement text (must differ from oldString)"),
  replaceAll: z.boolean().optional().describe("Replace all occurrences (default: false)"),
});

export const FILE_EDIT_TOOL_ID = "edit_file";

export async function fileEditImpl(
  args: Record<string, unknown>,
  
): Promise<{ result: string } | { error: string }> {
  const parsed = fileEditConfigSchema.safeParse(args);
  if (!parsed.success) {
    return { error: `Invalid args: ${parsed.error.message}` };
  }

  const { path: filePath, oldString, newString, replaceAll = false } = parsed.data;

  if (oldString === newString) {
    return { error: "old_string and new_string must be different" };
  }

  const MAX_FILE_SIZE = 500 * 1024;

  try {
    const resolvedPath = resolve(filePath);
    if (!existsSync(resolvedPath)) {
      return { error: `File not found: ${filePath}` };
    }

    const fileStat = statSync(resolvedPath);
    if (fileStat.size > MAX_FILE_SIZE) {
      return { error: `File too large: ${fileStat.size} bytes (max ${MAX_FILE_SIZE})` };
    }

    const content = readFileSync(resolvedPath, "utf-8");

    // ── Hash verification: file must have been read first ──
    const cachedHash = getReadHash(resolvedPath);
    if (!cachedHash) {
      return {
        error:
          `Must read file before editing: ${filePath}. ` +
          "Use read_file tool first, then edit_file with the exact old_string you read.",
      };
    }

    if (!verifyReadHash(resolvedPath, content)) {
      return {
        error:
          `File content has changed since last read: ${filePath}. ` +
          "Please re-read the file with read_file before editing.",
      };
    }

    // ── old_string uniqueness check ──
    const count = content.split(oldString).length - 1;
    if (count === 0) {
      return {
        error:
          `old_string not found in file. ` +
          "Ensure you copied the exact text from read_file output (including whitespace/indentation). " +
          `Hint: first 100 chars of provided old_string: "${oldString.slice(0, 100)}"`,
      };
    }

    if (count > 1 && !replaceAll) {
      return {
        error:
          `old_string appears ${count} times. ` +
          "Add more surrounding context to make it unique, or set replaceAll: true.",
      };
    }

    const newContent = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);

    const dir = dirname(resolvedPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolvedPath, newContent, "utf-8");

    return {
      result:
        `Successfully replaced ${replaceAll ? `all ${count}` : "1"} ` +
        `occurrence(s) in ${filePath}`,
    };
  } catch (err) {
    return { error: `Failed to edit file: ${err instanceof Error ? err.message : String(err)}` };
  }
}
