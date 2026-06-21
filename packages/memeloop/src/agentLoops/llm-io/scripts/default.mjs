// @ts-check

/** @param {import('../loop.js').LlmIoScriptContext} ctx */
export default async function* run(ctx) {
  yield* ctx.runDefaultLoop();
}