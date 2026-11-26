import { z } from 'zod';

import { safeErrorMessageFromUnknown } from '../../safeError.js';
import type { ToolSchemaWithSafeParse } from '../defineToolTypes.js';
import type { BuiltinToolContext } from './types.js';

export interface AskQuestionConfig {
  question: string;
  conversationId?: string;
  timeoutMs?: number;
  inputType?: 'single-select' | 'multi-select' | 'text';
  options?: Array<{ label: string; description?: string }>;
  allowFreeform: boolean;
}

const askQuestionConfigSchemaImpl = z.object({
  question: z.string().min(1),
  /**
   * Desktop / TidGi 的 LLM 工具参数里通常不会显式携带 conversationId，
   * 由宿主侧上下文负责关联；这里允许缺省，交给宿主回调侧做路由。
   */
  conversationId: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
  inputType: z.enum(['single-select', 'multi-select', 'text']).optional(),
  options: z
    .array(
      z.object({
        label: z.string(),
        description: z.string().optional(),
      }),
    )
    .optional(),
  allowFreeform: z.boolean().optional().default(true),
});

/** Publicly expose the parser through a structural contract, not Zod's class type. */
export const askQuestionConfigSchema: ToolSchemaWithSafeParse<AskQuestionConfig> = askQuestionConfigSchemaImpl;

/**
 * Must match `tool_use name="ask-question"` extracted by responsePatternUtility.
 */
export const ASK_QUESTION_TOOL_ID = 'ask-question';

export async function askQuestionImpl(
  arguments_: Record<string, unknown>,
  context: BuiltinToolContext,
): Promise<{ result: string } | { error: string }> {
  const parsed = askQuestionConfigSchemaImpl.safeParse(arguments_);
  if (!parsed.success) {
    return { error: 'invalid_askQuestion_args' };
  }
  const { question, conversationId, timeoutMs, inputType, options, allowFreeform } = parsed.data;
  const questionId = crypto.randomUUID();
  const timeout = timeoutMs ?? 300_000;
  context.notifyAskQuestion?.({
    questionId,
    question,
    conversationId,
    inputType,
    options,
    allowFreeform,
  });
  try {
    if (!context.questionWaits) {
      throw new Error('askQuestion requires a runtime-scoped QuestionWaitBroker');
    }
    const answer = await context.questionWaits.waitForQuestionAnswer(
      questionId,
      timeout,
      context.operationSignal,
    );
    return { result: answer };
  } catch (error) {
    return { error: safeErrorMessageFromUnknown(error, { fallback: 'askQuestion_failed' }) };
  }
}
