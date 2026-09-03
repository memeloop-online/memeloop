/**
 * 从 TidGi-Desktop `responsePatternUtility.ts` 迁移：解析 LLM 输出中的 XML 风格 tool 调用。
 * 仅做数据解析，不执行任何代码。
 */
import JSON5 from 'json5';
import { PORTABLE_LLM_STREAM_LIMITS } from '../llm/response.js';
import { canonicalizeToolArguments, MAX_TOOL_ARGUMENT_CANONICAL_BYTES, MAX_TOOL_ID_BYTES, ToolArgumentNormalizationError } from '../tools/structuredToolArguments.js';

const MAX_FALLBACK_INPUT_LENGTH = 1000;
const textEncoder = new TextEncoder();

/**
 * Bounds for the explicitly enabled text-tag tool-call protocol. Native provider calls are
 * validated by the portable stream accumulator; text tags arrive as one
 * untrusted string and need an equivalent boundary before regular-expression
 * matching or JSON parsing starts.
 */
export const RESPONSE_PATTERN_LIMITS = Object.freeze(
  {
    maxResponseBytes: PORTABLE_LLM_STREAM_LIMITS.aggregateBytes,
    maxToolCalls: 256,
    maxParameterBytes: MAX_TOOL_ARGUMENT_CANONICAL_BYTES,
    maxToolIdBytes: MAX_TOOL_ID_BYTES,
  } as const,
);

export type ResponsePatternParseErrorCode =
  | 'invalid_response'
  | 'response_too_large'
  | 'tool_call_limit'
  | 'parameters_too_large'
  | 'invalid_tool_id';

/** Stable fail-closed error emitted when the text tool-call boundary is exceeded. */
export class ResponsePatternParseError extends Error {
  public constructor(public readonly code: ResponsePatternParseErrorCode) {
    super(`response_pattern_${code}`);
    this.name = 'ResponsePatternParseError';
  }
}

export const TOOL_PARAMETER_PARSE_ERROR_KEY = '__memeloopToolParameterParseError';

export type ToolCallingMatch =
  | { found: false }
  | {
    found: true;
    /** Native provider tool-call identity. Text-tag calls omit it until the loop assigns one. */
    toolCallId?: string;
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

  if (utf8Bytes(parametersText) > RESPONSE_PATTERN_LIMITS.maxParameterBytes) {
    throw new ResponsePatternParseError('parameters_too_large');
  }

  const trimmedText = parametersText.trim();
  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmedText);
  } catch {
    /* try JSON5 */
    try {
      parsed = JSON5.parse(trimmedText);
    } catch {
      return invalidParameters(trimmedText);
    }
  }

  try {
    return canonicalizeToolArguments(parsed).parameters;
  } catch (error) {
    if (
      error instanceof ToolArgumentNormalizationError &&
      error.code === 'result_too_large'
    ) {
      throw new ResponsePatternParseError('parameters_too_large');
    }
    return invalidParameters(trimmedText);
  }
}

function invalidParameters(trimmedText: string): Record<string, unknown> {
  return {
    [TOOL_PARAMETER_PARSE_ERROR_KEY]: `Invalid tool arguments JSON. Return one valid JSON object inside the tool tag. Received: ${
      trimmedText.substring(0, MAX_FALLBACK_INPUT_LENGTH)
    }`,
  };
}

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function assertResponseText(responseText: unknown): asserts responseText is string {
  if (typeof responseText !== 'string') {
    throw new ResponsePatternParseError('invalid_response');
  }
  if (utf8Bytes(responseText) > RESPONSE_PATTERN_LIMITS.maxResponseBytes) {
    throw new ResponsePatternParseError('response_too_large');
  }
}

function assertToolId(toolId: string): void {
  if (toolId.length === 0 || utf8Bytes(toolId) > RESPONSE_PATTERN_LIMITS.maxToolIdBytes) {
    throw new ResponsePatternParseError('invalid_tool_id');
  }
}

function extractFunctionCallsParameters(text: string): Record<string, unknown> {
  // Parameter names come from model text; a null prototype keeps names such as
  // `__proto__` data-only until the canonical argument boundary is applied.
  const parameters = Object.create(null) as Record<string, unknown>;
  const parameterRegex = /<parameter\s+name="([^"]+)"[^>]*>([^<]*)<\/parameter>/g;
  let m: RegExpExecArray | null;
  while ((m = parameterRegex.exec(text)) !== null) {
    parameters[m[1]] = m[2].trim();
  }
  return parameters;
}

const toolPatterns: ToolPattern[] = [
  {
    name: 'tool_use',
    pattern: /<tool_use\s+name="([^"]+)"[^>]*>(.*?)<\/tool_use>/gis,
    extractToolId: (match) => match[1],
    extractParams: (match) => match[2],
    extractOriginalText: (match) => match[0],
  },
  {
    name: 'function_call',
    pattern: /<function_call\s+name="([^"]+)"[^>]*>(.*?)<\/function_call>/gis,
    extractToolId: (match) => match[1],
    extractParams: (match) => match[2],
    extractOriginalText: (match) => match[0],
  },
  {
    name: 'function_calls_invoke',
    pattern: /<invoke\s+name="([^"]+)"[^>]*>(.*?)<\/invoke>/gis,
    extractToolId: (match) => match[1],
    extractParams: (match) => JSON.stringify(extractFunctionCallsParameters(match[2])),
    extractOriginalText: (match) => match[0],
  },
];

export function matchToolCalling(responseText: string): ToolCallingMatch {
  assertResponseText(responseText);
  for (const toolPattern of toolPatterns) {
    toolPattern.pattern.lastIndex = 0;

    const match = toolPattern.pattern.exec(responseText);
    if (match) {
      const toolId = toolPattern.extractToolId(match);
      assertToolId(toolId);
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
}

export function matchAllToolCallings(responseText: string): {
  calls: Array<ToolCallingMatch & { found: true }>;
  parallel: boolean;
} {
  assertResponseText(responseText);
  const calls: Array<ToolCallingMatch & { found: true }> = [];
  const parallel = /<parallel_tool_calls>/i.test(responseText);

  for (const toolPattern of toolPatterns) {
    toolPattern.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = toolPattern.pattern.exec(responseText)) !== null) {
      if (calls.length >= RESPONSE_PATTERN_LIMITS.maxToolCalls) {
        throw new ResponsePatternParseError('tool_call_limit');
      }

      const toolId = toolPattern.extractToolId(match);
      assertToolId(toolId);
      calls.push({
        found: true,
        toolId,
        parameters: parseToolParameters(toolPattern.extractParams(match)),
        originalText: toolPattern.extractOriginalText(match),
      });
    }
  }

  return { calls, parallel };
}
