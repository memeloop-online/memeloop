/**
 * 从 TidGi-Desktop `responsePatternUtility.ts` 迁移：解析 LLM 输出中的 XML 风格 tool 调用。
 * 仅做数据解析，不执行任何代码。
 */
import JSON5 from "json5";

const MAX_FALLBACK_INPUT_LENGTH = 1000;

export type ToolCallingMatch =
  | { found: false }
  | {
      found: true;
      toolId: string;
      parameters: Record<string, unknown>;
      originalText: string;
    };

interface ToolPattern {
  name: string;
  pattern: RegExp;
  extractToolId: (match: RegExpExecArray) => string;
  extractParams: (match: RegExpExecArray) => string;
  extractOriginalText: (match: RegExpExecArray) => string;
}

function parseToolParameters(parametersText: string): Record<string, unknown> {
  if (!parametersText || !parametersText.trim()) {
    return {};
  }

  const trimmedText = parametersText.trim();

  try {
    return JSON.parse(trimmedText) as Record<string, unknown>;
  } catch {
    /* try JSON5 */
  }

  try {
    return JSON5.parse(trimmedText);
  } catch {
    /* fall through */
  }

  return { input: trimmedText.substring(0, MAX_FALLBACK_INPUT_LENGTH) };
}

const toolPatterns: ToolPattern[] = [
  {
    name: "tool_use",
    pattern: /<tool_use\s+name="([^"]+)"[^>]*>(.*?)<\/tool_use>/gis,
    extractToolId: (match) => match[1],
    extractParams: (match) => match[2],
    extractOriginalText: (match) => match[0],
  },
  {
    name: "function_call",
    pattern: /<function_call\s+name="([^"]+)"[^>]*>(.*?)<\/function_call>/gis,
    extractToolId: (match) => match[1],
    extractParams: (match) => match[2],
    extractOriginalText: (match) => match[0],
  },
];

export function matchToolCalling(responseText: string): ToolCallingMatch {
  try {
    for (const toolPattern of toolPatterns) {
      toolPattern.pattern.lastIndex = 0;

      const match = toolPattern.pattern.exec(responseText);
      if (match) {
        const toolId = toolPattern.extractToolId(match);
        const parametersText = toolPattern.extractParams(match);
        const originalText = toolPattern.extractOriginalText(match);

        return {
          found: true,
          toolId,
          parameters: parseToolParameters(parametersText),
          originalText,
        };
      }
    }

    return { found: false };
  } catch {
    return { found: false };
  }
}

export function matchAllToolCallings(responseText: string): {
  calls: Array<ToolCallingMatch & { found: true }>;
  parallel: boolean;
} {
  const calls: Array<ToolCallingMatch & { found: true }> = [];
  const parallel = /<parallel_tool_calls>/i.test(responseText);

  try {
    for (const toolPattern of toolPatterns) {
      toolPattern.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = toolPattern.pattern.exec(responseText)) !== null) {
        calls.push({
          found: true,
          toolId: toolPattern.extractToolId(match),
          parameters: parseToolParameters(toolPattern.extractParams(match)),
          originalText: toolPattern.extractOriginalText(match),
        });
      }
    }
  } catch {
    /* ignore */
  }

  return { calls, parallel };
}
