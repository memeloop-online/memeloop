// @ts-check

function resourceName(value) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return (normalized || "agent-run").slice(0, 48);
}

/** @param {import('../../loopAPI/agent-agent-loop/loop.js').AgentAgentScriptContext} ctx */
export default async function run(ctx) {
  if (!ctx.agentClient) {
    throw new Error("declarative-agent-run requires the orchestration resource facade");
  }

  const metadata = ctx.profile?.metadata ?? {};
  const childProfileId = typeof metadata.childProfileId === "string"
    ? metadata.childProfileId
    : ctx.agents[0]?.profileId;
  if (!childProfileId) {
    throw new Error("declarative-agent-run requires metadata.childProfileId or one configured agent");
  }

  const baseName = resourceName(`child-${ctx.input.conversationId}`);
  const workloadName = `${baseName}-workload`;
  const runName = `${baseName}-run`;
  const workload = await ctx.agentClient.createWorkload({
    name: workloadName,
    profileId: childProfileId,
    promptReference: `conversation:${ctx.input.conversationId}:input`,
    trust: "restricted",
    placement: {
      nodeSelector: { "memeloop.io/worker-pool": "restricted" },
      antiAffinity: [ctx.input.conversationId],
    },
    modelPolicy: {
      modelClass: "local-model",
      budget: { maxTokens: 8_192 },
    },
    toolPolicy: {
      defaultAction: "deny",
      allowedToolClasses: ["read-only"],
    },
    networkPolicy: {
      networkClass: "restricted-egress",
      egress: "restricted",
    },
    storagePolicy: {
      storageClass: "ephemeral",
    },
    completionPolicy: "complete",
    idempotencyKey: `${ctx.input.conversationId}:workload`,
  });
  const agentRun = await ctx.agentClient.createRun({
    name: runName,
    workloadName: workload.metadata.name,
    workloadNamespace: workload.metadata.namespace,
    promptReference: `conversation:${ctx.input.conversationId}:input`,
    timeoutMs: 120_000,
    idempotencyKey: `${ctx.input.conversationId}:run`,
  });

  if (metadata.waitForCompletion === true) {
    await ctx.agentClient.waitForRunCondition(
      agentRun.metadata.name,
      { type: "Completed", status: "True" },
      { timeout: 5_000, interval: 100 },
    );
  }

  ctx.finish(`scheduled ${workload.metadata.name}/${agentRun.metadata.name}`);
}
