// @ts-check

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function asEntries(value, fallback) {
  return Array.isArray(value) && value.length > 0 ? value : fallback;
}

function withConversationIds(ctx, entries, phase, iteration) {
  return entries.map((entry, index) => {
    const record = typeof entry === 'string' ? { profile: entry } : entry;
    return {
      ...record,
      conversationId: record.conversationId ?? `${ctx.input.conversationId}:${phase}:${iteration}:${index}`,
    };
  });
}

function resultText(ctx, result) {
  return result.text || ctx.formatAgentResults(result, { includeFailureSection: true });
}

function reviewText(ctx, result) {
  return ctx.formatAgentResults(result, { includeFailureSection: true });
}

function approved(result) {
  return result.failures.length === 0 &&
    result.results.length > 0 &&
    result.results.every(item => /^\s*APPROVED\b/imu.test(item.text));
}

function feedbackBlock(ctx, history) {
  if (history.length === 0) return 'No prior review feedback.';
  return history.map(entry => [
    `Iteration ${entry.iteration}`,
    `Attempt:\n${resultText(ctx, entry.attempt)}`,
    `Review:\n${reviewText(ctx, entry.review)}`,
  ].join('\n\n')).join('\n\n---\n\n');
}

function workerPrompt(ctx, goal, iteration, previousAttempt, history) {
  if (!previousAttempt) return goal;
  return [
    'Continue working on the original goal until the reviewer can approve it.',
    'Do not summarize the review. Produce the corrected deliverable itself.',
    `Original goal:\n${goal}`,
    `Previous deliverable:\n${resultText(ctx, previousAttempt)}`,
    `Review history:\n${feedbackBlock(ctx, history)}`,
    `This is revision attempt ${iteration}.`,
  ].join('\n\n');
}

function reviewPrompt(ctx, goal, attempt, history) {
  return [
    'You are the quality gate for this delegated agent run.',
    'Return APPROVED on the first line only when the deliverable fully satisfies the original goal and is ready to send to the user.',
    'Return REVISE on the first line when more work is required, followed by concrete blocking issues and exact changes needed.',
    'Do not approve partial progress.',
    `Original goal:\n${goal}`,
    `Candidate deliverable:\n${resultText(ctx, attempt)}`,
    `Earlier review history:\n${feedbackBlock(ctx, history)}`,
  ].join('\n\n');
}

async function runBatch(ctx, mode, input) {
  return mode === 'sequential' ? ctx.runSequential(input) : ctx.runParallel(input);
}

/** @param {import('../../loopAPI/agent-agent-loop/loop.js').AgentAgentScriptContext} ctx */
export default async function run(ctx) {
  const metadata = ctx.profile?.metadata ?? {};
  const goal = ctx.input.message;
  const maxIterations = positiveInteger(metadata.maxIterations, 4);
  const mode = metadata.mode === 'sequential' ? 'sequential' : 'parallel';
  const reviewMode = metadata.reviewMode === 'sequential' ? 'sequential' : 'parallel';
  const defaultAgents = ctx.getAgentEntries('agents');
  const workers = asEntries(ctx.getAgentEntries('workers'), asEntries(ctx.getAgentEntries('draftAgents'), defaultAgents));
  const reviewers = asEntries(ctx.getAgentEntries('reviewers'), asEntries(ctx.getAgentEntries('reviewAgents'), defaultAgents));
  const fixers = asEntries(ctx.getAgentEntries('fixers'), asEntries(ctx.getAgentEntries('revisionAgents'), workers));
  const history = [];
  let attempt;

  if (workers.length === 0 || reviewers.length === 0) {
    ctx.finish('AgentAgent quality gate requires worker and reviewer agents. Configure metadata.workers/reviewers or metadata.agents.');
    return;
  }

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    if (ctx.isCancelled()) break;
    const activeWorkers = iteration === 1 ? workers : fixers;
    ctx.emit({
      type: 'thinking',
      data: { status: 'quality-gate-work', conversationId: ctx.input.conversationId, iteration },
    });
    attempt = await runBatch(ctx, mode, {
      agents: withConversationIds(ctx, activeWorkers, 'work', iteration),
      prompt: workerPrompt(ctx, goal, iteration, attempt, history),
    });
    await ctx.checkpoint(`quality-gate:${iteration}:attempt`, attempt);

    if (attempt.failures.length > 0 && attempt.results.length === 0) {
      history.push({ iteration, attempt, review: { results: [], failures: attempt.failures, text: '' } });
      continue;
    }

    ctx.emit({
      type: 'thinking',
      data: { status: 'quality-gate-review', conversationId: ctx.input.conversationId, iteration },
    });
    const review = await runBatch(ctx, reviewMode, {
      agents: withConversationIds(ctx, reviewers, 'review', iteration),
      prompt: reviewPrompt(ctx, goal, attempt, history),
    });
    history.push({ iteration, attempt, review });
    await ctx.checkpoint(`quality-gate:${iteration}:review`, review);

    if (approved(review)) {
      ctx.finish(resultText(ctx, attempt));
      return;
    }
  }

  ctx.finish([
    'Quality gate did not approve the delegated work before the iteration limit.',
    attempt ? resultText(ctx, attempt) : 'No deliverable was produced.',
    'Review trail:',
    feedbackBlock(ctx, history),
  ].filter(Boolean).join('\n\n'));
}
