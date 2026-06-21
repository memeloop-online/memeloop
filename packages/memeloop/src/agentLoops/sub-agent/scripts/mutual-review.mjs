// @ts-check

/** @param {import('../loop.js').SubAgentScriptContext} ctx */
export default async function run(ctx) {
  const drafts = await ctx.runParallel();
  if (drafts.results.length < 2) {
    ctx.finishAgentResults(drafts);
    return;
  }

  const reviews = await ctx.runParallel({
    agents: drafts.results.map((draft, index) => {
      const reviewer = ctx.agents[(index + 1) % ctx.agents.length];
      return {
        ...reviewer,
        prompt: [
          'Review this answer against the original task.',
          `Original task:\n${ctx.input.message}`,
          `Answer from ${draft.profileId}:\n${draft.text}`,
        ].join('\n\n'),
        conversationId: `${ctx.input.conversationId}:review:${index}`,
      };
    }),
  });

  ctx.finish([
    'Drafts:',
    ctx.formatAgentResults(drafts, { includeFailureSection: false }),
    'Reviews:',
    ctx.formatAgentResults(reviews),
  ].join('\n\n'));
}