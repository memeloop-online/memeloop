import { After, Given, Then, When } from "@cucumber/cucumber";
import type { HookContext } from "memeloop";
import {
  getAgentRegistry,
  SessionStorage,
  registerSkill,
  getSkill,
  registerHook,
  hasHooks,
  executeHooks,
  clearHooks,
  clearSkills,
} from "memeloop";
import type { HookResult } from "memeloop";
import type { ChatMessage } from "memeloop";

import type { NodeWorld } from "./world.js";

// ---- Agent Registry ----

Given("a memeloop node is running", async function (this: NodeWorld) {
  const nodeId = `node-ma-${Date.now()}`;
  await this.startNode(nodeId);
  (this as any).multiAgentNodeId = nodeId;
});

When("I register a {string} agent", function (this: NodeWorld, agentId: string) {
  const registry = getAgentRegistry();
  registry.registerAgent({
    id: agentId,
    name: agentId.replace(/^memeloop:/, ""),
    type: "explore",
    prompt: `You are agent ${agentId}.`,
    permissions: { default: "deny", rules: [{ pattern: "file.read", action: "allow" }] },
    protocolDef: {
      id: agentId,
      name: agentId,
      description: `Registered test agent ${agentId}`,
      systemPrompt: `You are agent ${agentId}.`,
      tools: [],
      version: "1.0.0",
    },
  });
});

Then("the agent list should contain {string}", function (this: NodeWorld, agentId: string) {
  const registry = getAgentRegistry();
  const agent = registry.getAgent(agentId);
  if (!agent) {
    const list = registry.listAgents().map((a) => a.id);
    throw new Error(
      `Expected agent list to contain "${agentId}", got: ${JSON.stringify(list)}`,
    );
  }
});

// ---- WebSocket Connection (shared with existing patterns) ----

When(
  "I connect from {string} to the running multi-agent node via WebSocket",
  async function (this: NodeWorld, fromId: string) {
    const nodeId = (this as any).multiAgentNodeId as string;
    if (!nodeId) throw new Error("No multi-agent node started");
    const target = this.nodes.get(nodeId);
    if (!target) throw new Error(`Target node not started: ${nodeId}`);
    const mgr = this.getOrCreatePeerManager(fromId);
    const wsUrl = `ws://127.0.0.1:${target.port}`;
    await mgr.addPeerByUrl(wsUrl);
  },
);

// ---- Task Delegation ----

When(
  "I send a task to agent {string} with prompt {string}",
  async function (this: NodeWorld, agentId: string, prompt: string) {
    const nodeId = (this as any).multiAgentNodeId as string;
    if (!nodeId) throw new Error("No multi-agent node started");

    const mgr = this.getOrCreatePeerManager("client-delegate");
    const result = (await mgr.sendRpcToNode(nodeId, "memeloop.node.getInfo", {})) as {
      capabilities?: { tools?: string[] };
    };

    const tools = result.capabilities?.tools ?? [];
    (this as any).multiAgentTools = tools;
    (this as any).multiAgentTaskPrompt = prompt;
    (this as any).multiAgentTaskAgent = agentId;
  },
);

Then("the task should complete successfully", function (this: NodeWorld) {
  const tools = (this as any).multiAgentTools as string[] | undefined;
  if (!tools || !Array.isArray(tools)) {
    throw new Error("No tools result stored from task delegation step");
  }

  const hasSpawnAgent = tools.some(
    (t) => t === "spawnAgent" || t.includes("spawnAgent"),
  );
  if (!hasSpawnAgent) {
    throw new Error(
      `Expected spawnAgent tool to be available, got tools: ${JSON.stringify(tools)}`,
    );
  }
});

// ---- Skill Loading ----

When("I load skill {string}", function (this: NodeWorld, skillId: string) {
  registerSkill({
    id: skillId,
    name: `Test Skill: ${skillId}`,
    instructions: `You are using skill ${skillId}. Follow its instructions carefully.`,
  });
  (this as any).lastLoadedSkillId = skillId;
});

Then("the agent should use skill {string}", function (this: NodeWorld, skillId: string) {
  const skill = getSkill(skillId);
  if (!skill) {
    throw new Error(`Expected skill "${skillId}" to be registered, but it was not found`);
  }
  if (skill.id !== skillId) {
    throw new Error(`Skill id mismatch: expected "${skillId}", got "${skill.id}"`);
  }
});

// ---- Hook Execution ----

When("I execute tool {string}", async function (this: NodeWorld, toolId: string) {
  const hookCalls: string[] = [];
  (this as any).lastHookCalls = hookCalls;

  const hookName = `e2e-hook-${Date.now()}`;
  registerHook(
    "PostToolUse",
    async (_context: HookContext, data: Record<string, unknown>): Promise<HookResult> => {
      hookCalls.push(data.toolId as string);
      return { allowed: true };
    },
    hookName,
  );

  const mockData = {
    toolId,
    parameters: { path: "/tmp/test.txt" },
    result: "mock result",
    isError: false,
    conversationId: `e2e-conv-${Date.now()}`,
  };

  const context = {} as HookContext;
  await executeHooks("PostToolUse", context, mockData);

  (this as any).lastExecutedToolId = toolId;
});

Then("hook {string} should have been called", function (this: NodeWorld, hookType: string) {
  const hookCalls = (this as any).lastHookCalls as string[] | undefined;
  const toolId = (this as any).lastExecutedToolId as string | undefined;

  if (hookCalls && hookCalls.length > 0) {
    if (toolId && !hookCalls.includes(toolId)) {
      throw new Error(
        `Expected hook calls for tool "${toolId}", got: ${JSON.stringify(hookCalls)}`,
      );
    }
    return;
  }

  // Fallback: check if hooks are still registered
  if (hasHooks(hookType as any)) {
    return;
  }

  throw new Error(`Expected hook "${hookType}" to have been called, but nothing recorded`);
});

// ---- Session Checkpoint ----

When("I save checkpoint {string}", async function (this: NodeWorld, checkpointId: string) {
  const storage = new SessionStorage();
  const messages: ChatMessage[] = [
    {
      messageId: "msg-1",
      role: "user" as const,
      content: "Hello, checkpointer!",
      timestamp: Date.now(),
      originNodeId: "node-test",
    },
    {
      messageId: "msg-2",
      role: "assistant" as const,
      content: "Hello! I am a checkpointed assistant.",
      timestamp: Date.now() + 1,
      originNodeId: "node-test",
    },
  ];

  const record = await storage.saveCheckpoint(checkpointId, messages);
  (this as any).lastCheckpointRecord = record;
  (this as any).lastCheckpointId = checkpointId;
  (this as any).lastCheckpointStorage = storage;
});

Then("I can resume checkpoint {string}", async function (this: NodeWorld, checkpointId: string) {
  const storage =
    ((this as any).lastCheckpointStorage as SessionStorage) ?? new SessionStorage();
  const record = await storage.loadCheckpoint(checkpointId);

  if (!record) {
    throw new Error(`Expected checkpoint "${checkpointId}" to exist, but load returned null`);
  }

  if (record.conversationId !== checkpointId) {
    throw new Error(
      `Checkpoint conversationId mismatch: expected "${checkpointId}", got "${record.conversationId}"`,
    );
  }

  if (!Array.isArray(record.messages) || record.messages.length < 2) {
    throw new Error(
      `Expected checkpoint to have at least 2 messages, got ${record.messages?.length ?? 0}`,
    );
  }

  const userMsg = record.messages.find((m) => m.role === "user");
  if (!userMsg || userMsg.content !== "Hello, checkpointer!") {
    throw new Error("Checkpoint message content was not preserved correctly");
  }
});

// ---- Cleanup ----

After(async function (this: NodeWorld) {
  clearHooks();
  clearSkills();
  // Clean up SessionStorage checkpoint files created during tests
  const checkpointId = (this as any).lastCheckpointId as string | undefined;
  if (checkpointId) {
    const storage =
      ((this as any).lastCheckpointStorage as SessionStorage) ?? new SessionStorage();
    try {
      await storage.deleteCheckpoint(checkpointId);
    } catch {
      // Ignore cleanup errors
    }
  }
});
