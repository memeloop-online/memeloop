// @ts-check

function resourceName(value) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return (normalized || "artifact").slice(0, 56);
}

/** @param {import('../../loopAPI/agent-agent-loop/loop.js').AgentAgentScriptContext} ctx */
export default async function run(ctx) {
  if (!ctx.orchestration) {
    throw new Error("artifact-resource-lifecycle requires the orchestration resource facade");
  }

  const metadata = ctx.profile?.metadata ?? {};
  const contentHash = typeof metadata.contentHash === "string"
    ? metadata.contentHash
    : "sha256:0000000000000000000000000000000000000000000000000000000000000000";
  const artifactName = resourceName(`script-${ctx.input.conversationId}`);
  const query = {
    apiVersion: "artifacts.memeloop.io/v1alpha1",
    kind: "ArtifactRecord",
    namespace: "default",
  };
  const abortController = new AbortController();
  const events = ctx.orchestration.watch(query, {
    resourceVersion: "0",
    sendInitialEvents: true,
    allowBookmarks: true,
    timeoutMs: 5_000,
    signal: abortController.signal,
  })[Symbol.asyncIterator]();
  const nextEvent = events.next();

  try {
    const artifact = await ctx.orchestration.apply({
      apiVersion: query.apiVersion,
      kind: query.kind,
      metadata: {
        name: artifactName,
        namespace: query.namespace,
        labels: { "memeloop.io/artifact-purpose": "generated-script" },
      },
      spec: {
        contentHash,
        mimeType: "text/javascript",
        producer: { trust: "restricted" },
        trust: "restricted",
      },
    }, {
      fieldManager: "agent-agent-script-example",
      idempotencyKey: `${ctx.input.conversationId}:artifact`,
    });

    const observed = await nextEvent;
    if (observed.done || observed.value.type !== "ADDED") {
      throw new Error("artifact watch ended before observing the created resource");
    }

    const reference = {
      apiVersion: artifact.apiVersion,
      kind: artifact.kind,
      name: artifact.metadata.name,
      namespace: artifact.metadata.namespace,
      uid: artifact.metadata.uid,
    };
    const fetched = await ctx.orchestration.get(reference, {
      resourceVersion: artifact.metadata.resourceVersion,
    });
    const listed = await ctx.orchestration.list(query, {
      resourceVersion: artifact.metadata.resourceVersion,
      resourceVersionMatch: "not-older-than",
      limit: 10,
    });
    if (!fetched || !listed.items.some((item) => item.metadata.uid === artifact.metadata.uid)) {
      throw new Error("created artifact was not readable through the resource facade");
    }

    await ctx.orchestration.delete(reference, {
      idempotencyKey: `${ctx.input.conversationId}:artifact-delete`,
      preconditions: {
        uid: artifact.metadata.uid,
        resourceVersion: artifact.metadata.resourceVersion,
      },
    });
    ctx.finish(`verified artifact lifecycle ${artifact.metadata.name}@${observed.value.resourceVersion}`);
  } finally {
    abortController.abort();
    await events.return?.();
  }
}
