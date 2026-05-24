/**
 * AskUserQuestion Tool — Pause agent execution and ask user for input.
 *
 * Uses the existing askQuestion pattern (notifyAskQuestion + waitForQuestionAnswer)
 * but provides a dedicated tool ID for explicit user question prompting.
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { BuiltinToolContext } from "./types.js";
import { waitForQuestionAnswer } from "./questionWaitRegistry.js";

export const askUserQuestionConfigSchema = z.object({
  question: z.string().min(1).describe("The question to ask the user"),
  inputType: z
    .enum(["text", "single-select", "multi-select"])
    .optional()
    .default("text")
    .describe("Type of input expected: text, single-select, or multi-select"),
  options: z
    .array(
      z.object({
        label: z.string().min(1),
        description: z.string().optional(),
      }),
    )
    .optional()
    .describe("Options for single-select or multi-select input types"),
  allowFreeform: z
    .boolean()
    .optional()
    .default(true)
    .describe("Allow free-text input even for select types"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(3_600_000)
    .optional()
    .default(300_000)
    .describe("Timeout in milliseconds (default 5 minutes)"),
});

export const ASK_USER_QUESTION_TOOL_ID = "askUserQuestion";

export async function askUserQuestionImpl(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ result: string } | { error: string }> {
  const parsed = askUserQuestionConfigSchema.safeParse(args);
  if (!parsed.success) {
    return { error: `invalid_askUserQuestion_args: ${parsed.error.message}` };
  }

  const { question, inputType, options, allowFreeform, timeoutMs } = parsed.data;
  const questionId = randomUUID();
  const conversationId = ctx.agent?.id ?? ctx.activeToolConversationId;

  ctx.notifyAskQuestion?.({
    questionId,
    question,
    conversationId,
    inputType,
    options,
    allowFreeform,
  });

  try {
    const answer = await waitForQuestionAnswer(questionId, timeoutMs);
    return { result: answer };
  } catch (err) {
    const message = err instanceof Error ? err.message : "askUserQuestion_failed";
    return { error: message };
  }
}
