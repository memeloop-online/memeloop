// @ts-check

/** @param {import('../loop.js').SubAgentScriptContext} ctx */
export default async function run(ctx) {
  ctx.finishAgentResults(await ctx.runSequential());
}