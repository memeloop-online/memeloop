// @ts-check

/** @param {import('../../loopAPI/agent-tool-loop/loop.js').AgentToolLoopScriptContext} ctx */
export default async function* run(ctx) {
  const state = ctx.createState();

  try {
    const start = await ctx.startTurn(state);
    if (start.step) yield start.step;
    if (start.action === 'stop') return;

    while (true) {
      const result = yield* ctx.runIteration(state);
      if (result.action === 'stop') return;
    }
  } catch (error) {
    await ctx.stopTurn(state, 'error');
    throw error;
  } finally {
    await ctx.stopTurn(state);
  }
}