import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { waitForQuestionAnswer } from './questionWaitRegistry.js';
import type { BuiltinToolContext } from './types.js';

export const askQuestionConfigSchema = z.object({
  question: z.string().min(1),
  /**
   * Desktop / TidGi 的 LLM 工具参数里通常不会显式携带 conversationId，
   * 由宿主侧上下文负责关联；这里允许缺省，交给宿主回调侧做路由。
   */
  conversationId: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
  inputType: z.enum(['single-select', 'multi-select', 'text']).optional(),
  options: z.array(
    z.object({
      label: z.string(),
      description: z.string().optional(),
    }),
  ).optional(),
  allowFreeform: z.boolean().optional().default(true),
});

/**
 * Must match `tool_use name="ask-question"` extracted by responsePatternUtility.
 */
export const ASK_QUESTION_TOOL_ID = 'ask-question';

export async function askQuestionImpl(
  arguments_: Record<string, unknown>,
  context: BuiltinToolContext,
): Promise<{ result: string } | { error: string }> {
  const parsed = askQuestionConfigSchema.safeParse(arguments_);
  if (!parsed.success) {
    return { error: 'invalid_askQuestion_args' };
  }
  const { question, conversationId, timeoutMs, inputType, options, allowFreeform } = parsed.data;
  const questionId = randomUUID();
  const timeout = timeoutMs ?? 300_000;
  context.notifyAskQuestion?.({ questionId, question, conversationId, inputType, options, allowFreeform });
  try {
    const answer = await waitForQuestionAnswer(questionId, timeout);
    return { result: answer };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'askQuestion_failed' };
  }
}
