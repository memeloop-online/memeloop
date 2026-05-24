# Skills System

Skills extend agent capabilities by bundling tools, instructions, and configuration into reusable, composable units that can be attached to agents.

## What Are Skills

A **skill** is a named capability package containing:

- **Instructions** — Specialized system prompt fragments or behavioral guidelines
- **Tools** — A whitelist of tools this skill provides access to
- **Metadata** — Category, version, and dependencies

Skills enable:

- **Modular agent composition** — Attach `security-audit` and `performance-review` skills to an oracle agent
- **Capability reuse** — Define a skill once, use it across multiple agents
- **Dynamic tool scoping** — Skills restrict which tools an agent can invoke beyond base permissions

## Current Implementation Status

The skills system has schema support in `memeloop-cloud` and type definitions in the agent registry. The runtime skill execution engine is planned for Phase 3 of the multi-agent roadmap.

### Existing Schema (memeloop-cloud)

```typescript
// packages/memeloop-cloud/src/db.ts
// SQLite schema for skills

db.exec(`
  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    instructions TEXT,
    tools TEXT DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('build', 'plan', 'explore', 'oracle', 'librarian')),
    description TEXT,
    skills TEXT DEFAULT '[]',
    prompt TEXT
  );
`);
```

### Agent Type Integration

```typescript
// packages/memeloop/src/agent/agentTypes.ts

export interface AgentRegistryEntry {
  id: string;
  name: string;
  type: AgentType;
  prompt: string;
  permissions: ToolPermissionRules;
  model?: string;
  skills?: string[]; // Skill identifiers this agent has access to
  protocolDef: ProtocolAgentDefinition;
}
```

## Skill Directory Structure

A skill package follows this directory layout:

```
skills/
  security-audit/
    skill.json          # Manifest
    instructions.md     # System prompt fragment
    schemas/            # Zod schemas for skill-specific tools
      scan-schema.ts
  performance-review/
    skill.json
    instructions.md
```

### Skill Manifest (`skill.json`)

```json
{
  "id": "security-audit",
  "name": "Security Audit",
  "version": "1.0.0",
  "description": "Analyze code for security vulnerabilities and CVEs",
  "category": "code-quality",
  "instructions": "./instructions.md",
  "tools": [
    "file.read",
    "file.search",
    "grep.search",
    "web.cveLookup",
    "lsp.diagnostics"
  ],
  "dependencies": []
}
```

### Instructions File (`instructions.md`)

```markdown
# Security Audit Skill

When reviewing code:
1. Check for SQL injection vectors in string concatenation
2. Validate input sanitization on all user-facing endpoints
3. Flag hardcoded secrets, tokens, or credentials
4. Verify dependency versions against known CVE databases
5. Report findings with severity: critical / high / medium / low
```

## How to Create Custom Skills

### Step 1: Define the Skill Manifest

```typescript
// skills/my-skill/skill.ts
import type { SkillManifest } from "memeloop/skills";

export const manifest: SkillManifest = {
  id: "api-testing",
  name: "API Testing",
  version: "1.0.0",
  description: "Generate and run API test cases from OpenAPI specs",
  category: "testing",
  instructions: `
You are an API testing specialist. Given an OpenAPI spec or endpoint description:
1. Generate boundary value test cases
2. Generate negative test cases (invalid auth, malformed payloads)
3. Use the http.request tool to execute tests
4. Report pass/fail with response status and latency
`,
  tools: ["file.read", "web.fetch", "http.request", "terminal.exec"],
  configSchema: {
    type: "object",
    properties: {
      baseUrl: { type: "string", description: "API base URL for tests" },
      timeoutMs: { type: "number", default: 5000 },
    },
    required: ["baseUrl"],
  },
};
```

### Step 2: Register the Skill

```typescript
import { getSkillRegistry } from "memeloop/skills";
import { manifest } from "./skills/api-testing/skill";

const registry = getSkillRegistry();
registry.registerSkill(manifest);

// Verify
const skill = registry.getSkill("api-testing");
console.log(skill?.name); // "API Testing"
```

### Step 3: Attach Skill to an Agent

```typescript
import { getAgentRegistry } from "memeloop/agent/agentRegistry";

const agentRegistry = getAgentRegistry();
const buildAgent = agentRegistry.getAgent("memeloop:build");

if (buildAgent) {
  // Add skill reference
  buildAgent.skills = [...(buildAgent.skills ?? []), "api-testing"];

  // The agent's effective permissions now intersect with the skill's tool list:
  // Allowed = agent permissions ∩ skill tools
}
```

### Step 4: Runtime Skill Resolution (Planned)

```typescript
// When TaskAgent prepares an agent turn, it resolves skills:
function resolveAgentSkills(
  agentDef: AgentRegistryEntry,
  skillRegistry: SkillRegistry,
): ResolvedSkill[] {
  const resolved: ResolvedSkill[] = [];
  for (const skillId of agentDef.skills ?? []) {
    const skill = skillRegistry.getSkill(skillId);
    if (skill) {
      resolved.push({
        id: skill.id,
        instructions: skill.instructions,
        tools: skill.tools,
      });
    }
  }
  return resolved;
}

// Resolved skills are injected into the prompt:
// 1. Skill instructions appended to system prompt
// 2. Skill tools added to the agent's tool whitelist
// 3. Skill config merged into agentFrameworkConfig
```

## Built-in Skills Reference

The following skills are planned for the core distribution:

| Skill ID | Category | Description | Tools |
|----------|----------|-------------|-------|
| `security-audit` | `code-quality` | CVE lookup, secret scanning | `file.read`, `grep.search`, `web.cveLookup` |
| `performance-review` | `code-quality` | Bottleneck analysis, profiling | `file.read`, `lsp.diagnostics`, `terminal.exec` |
| `api-testing` | `testing` | Generate and run API tests | `file.read`, `web.fetch`, `http.request` |
| `refactoring` | `maintenance` | Safe code modernization | `file.read`, `file.write`, `lsp.*` |
| `documentation` | `communication` | Generate docs from code | `file.read`, `file.write`, `glob.*` |

## Skill Configuration in Agent Framework Config

```typescript
const agentDefinition: AgentDefinition = {
  id: "myteam:api-tester",
  name: "API Tester",
  description: "Agent with API testing skill",
  systemPrompt: "You are an API testing specialist.",
  tools: [],
  version: "1.0.0",
  agentFrameworkConfig: {
    skills: ["api-testing"],
    skillConfig: {
      "api-testing": {
        baseUrl: "https://api.example.com",
        timeoutMs: 10000,
      },
    },
    prompts: [
      {
        id: "system",
        text: "{{skillInstructions}}",
        enabled: true,
      },
    ],
    plugins: [],
    response: [],
  },
};
```

## Skill-Scoped Tool Permissions

Skills can further restrict tool access beyond the agent's base permissions:

```typescript
// Effective permission resolution
function computeEffectivePermissions(
  agentPermissions: ToolPermissionRules,
  skills: ResolvedSkill[],
): ToolPermissionRules {
  // Start with agent permissions
  const effective = { ...agentPermissions };

  // Intersect with skill tool whitelists
  const skillTools = new Set(skills.flatMap((s) => s.tools));
  if (skillTools.size > 0) {
    effective.rules = effective.rules.filter(
      (r) => skillTools.has(r.pattern) || r.pattern === "*",
    );
    // Implicitly deny anything not in skill tools
    effective.rules.push({ pattern: "*", action: "deny" });
  }

  return effective;
}
```

## Cloud Admin Integration

In `memeloop-cloud`, skills are managed via the admin API:

```typescript
// Create a skill via admin API
POST /api/skills
{
  "id": "custom-linter",
  "name": "Custom Linter",
  "instructions": "Lint code according to team style guide...",
  "tools": ["file.read", "file.search", "terminal.eslint"]
}

// Attach skill to agent
PATCH /api/agents/myteam:build
{
  "skills": ["custom-linter", "security-audit"]
}

// List all skills
GET /api/skills
```

## Testing Skills

```typescript
import { describe, it, expect } from "vitest";
import { SkillRegistry } from "memeloop/skills";

describe("SkillRegistry", () => {
  it("registers and resolves a skill", () => {
    const registry = new SkillRegistry();
    registry.registerSkill({
      id: "test-skill",
      name: "Test Skill",
      version: "1.0.0",
      description: "A test skill",
      category: "testing",
      instructions: "Test instructions",
      tools: ["file.read"],
    });

    const skill = registry.getSkill("test-skill");
    expect(skill).toBeDefined();
    expect(skill?.tools).toContain("file.read");
  });

  it("resolves multiple skills for an agent", () => {
    const registry = new SkillRegistry();
    registry.registerSkill({ id: "s1", name: "S1", version: "1", category: "test", instructions: "", tools: ["a"] });
    registry.registerSkill({ id: "s2", name: "S2", version: "1", category: "test", instructions: "", tools: ["b"] });

    const resolved = registry.resolveSkills(["s1", "s2"]);
    expect(resolved).toHaveLength(2);
    expect(resolved.flatMap((s) => s.tools)).toEqual(["a", "b"]);
  });
});
```

## Best Practices

1. **Keep skills focused** — A skill should address one concern (e.g., `security-audit`, not `security-and-testing`)
2. **Version your skills** — Use semantic versioning in `skill.json` for compatibility tracking
3. **Minimize tool lists** — Only include tools the skill actually needs
4. **Write explicit instructions** — Skill instructions are appended to the system prompt; be specific about behavior
5. **Use categories** — Group related skills (see `docs/CATEGORIES.md`) for discoverability
6. **Test skill permissions** — Verify that skill-scoped restrictions don't break agent workflows
