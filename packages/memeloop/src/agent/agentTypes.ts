import type { AgentDefinition as ProtocolAgentDefinition } from "@memeloop/protocol";

/**
 * Extended agent definition used by the agent registry.
 * Wraps the protocol-level AgentDefinition with additional runtime metadata.
 */
export interface AgentRegistryEntry {
  /** Unique ID for this agent (matches protocol id convention like "memeloop:build") */
  id: string;
  /** Display name */
  name: string;
  /** Agent type / role */
  type: AgentType;
  /** System prompt / instructions for the agent */
  prompt: string;
  /** Tool permission rules (mutually exclusive with permissive defaults) */
  permissions: ToolPermissionRules;
  /** Optional model override (provider/model string) */
  model?: string;
  /** Optional skill identifiers this agent has access to */
  skills?: string[];
  /** Underlying protocol-compatible definition for framework integration */
  protocolDef: ProtocolAgentDefinition;
}

export type AgentType = "build" | "plan" | "explore" | "oracle" | "librarian";

export interface ToolPermissionRules {
  /** Default action for tools not matching any rule */
  default: "allow" | "ask" | "deny";
  /** Per-tool or wildcard rules */
  rules: Array<{ pattern: string; action: "allow" | "ask" | "deny" }>;
}

function makeBuiltinDef(
  id: string,
  name: string,
  type: AgentType,
  prompt: string,
  permissions: ToolPermissionRules,
  model?: string,
  skills?: string[],
): AgentRegistryEntry {
  const systemPrompt = prompt;
  const tools: string[] = []; // runtime tools; permissions govern access
  return {
    id,
    name,
    type,
    prompt,
    permissions,
    model,
    skills,
    protocolDef: {
      id,
      name,
      description: prompt.slice(0, 200),
      systemPrompt,
      tools,
      version: "1.0.0",
      modelConfig: model
        ? { provider: model.split("/")[0] ?? "memeloop", model: model.split("/").slice(1).join("/") || model }
        : undefined,
    },
  };
}

/**
 * Build agent: full access, default model.
 * Primary agent for executing tasks, writing code, running commands.
 */
export const buildAgent: AgentRegistryEntry = makeBuiltinDef(
  "memeloop:build",
  "Build Agent",
  "build",
  "You are a build agent capable of executing tasks, writing and editing files, running commands, and making changes. Use tools to accomplish the user's goals efficiently.",
  { default: "allow", rules: [] },
);

/**
 * Plan agent: read-only, denies file edits and terminal execution.
 * Used for high-level planning and task decomposition.
 */
export const planAgent: AgentRegistryEntry = makeBuiltinDef(
  "memeloop:plan",
  "Plan Agent",
  "plan",
  "You are a planning agent. Your role is to analyze requirements, decompose tasks, and create structured plans. You CANNOT write files or execute terminal commands. Only use read and search tools.",
  {
    default: "deny",
    rules: [
      { pattern: "file.read", action: "allow" },
      { pattern: "file.search", action: "allow" },
      { pattern: "file.list", action: "allow" },
      { pattern: "grep.search", action: "allow" },
      { pattern: "glob.*", action: "allow" },
    ],
  },
);

/**
 * Explore agent: read + search tools only.
 * Fast search and codebase exploration without modification.
 */
export const exploreAgent: AgentRegistryEntry = makeBuiltinDef(
  "memeloop:explore",
  "Explore Agent",
  "explore",
  "You are an exploration agent specialized in fast codebase search and discovery. You have read and search tools. Do NOT modify files or run terminal commands. Focus on finding relevant code, files, and patterns.",
  {
    default: "deny",
    rules: [
      { pattern: "file.read", action: "allow" },
      { pattern: "file.search", action: "allow" },
      { pattern: "file.list", action: "allow" },
      { pattern: "grep.search", action: "allow" },
      { pattern: "glob.*", action: "allow" },
      { pattern: "lsp.*", action: "allow" },
    ],
  },
);

/**
 * Oracle agent: read-only, for architecture consultation and code review.
 */
export const oracleAgent: AgentRegistryEntry = makeBuiltinDef(
  "memeloop:oracle",
  "Oracle Agent",
  "oracle",
  "You are an oracle agent specialized in architecture analysis, code review, and constraint verification. You have read access only. Review code, identify issues, and provide expert architectural guidance.",
  {
    default: "deny",
    rules: [
      { pattern: "file.read", action: "allow" },
      { pattern: "file.search", action: "allow" },
      { pattern: "file.list", action: "allow" },
      { pattern: "grep.search", action: "allow" },
      { pattern: "glob.*", action: "allow" },
      { pattern: "lsp.*", action: "allow" },
    ],
  },
);

/**
 * Librarian agent: read + web search tools only.
 * External documentation lookup and context gathering.
 */
export const librarianAgent: AgentRegistryEntry = makeBuiltinDef(
  "memeloop:librarian",
  "Librarian Agent",
  "librarian",
  "You are a librarian agent specialized in external documentation lookup, web search, and context gathering. Use web search tools to find relevant documentation, APIs, and examples. Do NOT modify files or run terminal commands.",
  {
    default: "deny",
    rules: [
      { pattern: "file.read", action: "allow" },
      { pattern: "file.search", action: "allow" },
      { pattern: "file.list", action: "allow" },
      { pattern: "web.*", action: "allow" },
      { pattern: "grep.search", action: "allow" },
      { pattern: "glob.*", action: "allow" },
    ],
  },
);

/** All pre-built agent definitions */
export const PREDEFINED_AGENTS: AgentRegistryEntry[] = [
  buildAgent,
  planAgent,
  exploreAgent,
  oracleAgent,
  librarianAgent,
];
