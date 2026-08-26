/**
 * AskUserQuestion Tool — Pause agent execution and ask user for input.
 *
 * Uses the existing askQuestion pattern (notifyAskQuestion + waitForQuestionAnswer)
 * but provides a dedicated tool ID for explicit user question prompting.
 */
import { z } from 'zod';

import { safeErrorMessageFromUnknown } from '../../safeError.js';
import type { BuiltinToolContext } from './types.js';

export const askUserQuestionConfigSchema = z.object({
  question: z.string().min(1).describe('The question to ask the user'),
  inputType: z
    .enum(['text', 'single-select', 'multi-select'])
    .optional()
    .default('text')
    .describe('Type of input expected: text, single-select, or multi-select'),
  options: z
    .array(
      z.object({
        label: z.string().min(1),
        description: z.string().optional(),
      }),
    )
    .optional()
    .describe('Options for single-select or multi-select input types'),
  allowFreeform: z
    .boolean()
    .optional()
    .default(true)
    .describe('Allow free-text input even for select types'),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(3_600_000)
    .optional()
    .default(300_000)
    .describe('Timeout in milliseconds (default 5 minutes)'),
});

export const ASK_USER_QUESTION_TOOL_ID = 'askUserQuestion';

export async function askUserQuestionImpl(
  arguments_: Record<string, unknown>,
  context: BuiltinToolContext,
): Promise<{ result: string } | { error: string }> {
  const parsed = askUserQuestionConfigSchema.safeParse(arguments_);
  if (!parsed.success) {
    return { error: `invalid_askUserQuestion_args: ${parsed.error.message}` };
  }

  const { question, inputType, options, allowFreeform, timeoutMs } = parsed.data;
  const questionId = crypto.randomUUID();
  const conversationId = context.agent?.id ?? context.activeToolConversationId;

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
      throw new Error('askUserQuestion requires a runtime-scoped QuestionWaitBroker');
    }
    const answer = await context.questionWaits.waitForQuestionAnswer(
      questionId,
      timeoutMs,
      context.operationSignal,
    );
    return { result: answer };
  } catch (error) {
    const message = safeErrorMessageFromUnknown(error, { fallback: 'askUserQuestion_failed' });
    return { error: message };
  }
}
