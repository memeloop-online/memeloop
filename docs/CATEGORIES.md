# Category System

The category system enables semantic routing and organization of agents, skills, and tasks. Categories act as capability tags that help the system delegate work to the most appropriate agent based on the nature of the request.

## Overview

Categories provide:

- **Semantic routing** — Automatically match tasks to agents by category
- **Agent organization** — Group related agents and skills
- **Capability discovery** — Browse available capabilities by domain
- **Workflow orchestration** — Planning → Execution → Workers pipeline

## Category System Architecture

```
User Request
    |
    v
[Category Classifier] ----> Matches request to categories
    |
    v
[Agent Resolver] --------> Finds agents with matching categories
    |
    v
[Task Delegation] -------> Delegates to best-matching agent(s)
```

## Default Categories and Their Purposes

### Core Categories

| Category | Purpose | Typical Agents | Typical Skills |
|----------|---------|--------------|--------------|
| `build` | Code generation, file modification, command execution | `memeloop:build` | `refactoring`, `code-generation` |
| `plan` | Task decomposition, architecture analysis, estimation | `memeloop:plan` | `requirements-analysis` |
| `explore` | Codebase search, discovery, navigation | `memeloop:explore` | `code-search`, `dependency-analysis` |
| `oracle` | Review, audit, constraint verification | `memeloop:oracle` | `security-audit`, `performance-review` |
| `librarian` | Documentation lookup, web search, context gathering | `memeloop:librarian` | `documentation`, `api-reference` |

### Extended Categories

| Category | Purpose | Example Tasks |
|----------|---------|--------------|
| `visual-engineering` | UI/UX implementation, CSS, image generation | "Create a responsive navbar", "Generate a logo" |
| `ultrabrain` | Complex multi-step reasoning, research | "Design a distributed system", "Analyze market trends" |
| `artistry` | Creative writing, content generation, styling | "Write a blog post", "Draft release notes" |
| `quick` | Fast, single-tool operations | "Read this file", "Run git status" |
| `writing` | Documentation, comments, string content | "Document this API", "Add JSDoc comments" |
| `testing` | Test generation, test execution, coverage | "Generate unit tests", "Run the test suite" |
| `maintenance` | Refactoring, cleanup, dependency updates | "Update dependencies", "Remove dead code" |
| `communication` | Messaging, notifications, summaries | "Summarize PR changes", "Draft a Slack message" |

## How to Configure Categories

### Category Manifest

```typescript
// categories/core.ts
import type { CategoryDefinition } from "memeloop/categories";

export const buildCategory: CategoryDefinition = {
  id: "build",
  name: "Build",
  description: "Code generation and file modification tasks",
  keywords: ["write", "edit", "create", "generate", "implement", "fix", "refactor"],
  requiredTools: ["file.write", "file.edit", "terminal.exec"],
  preferredAgents: ["memeloop:build"],
  fallbackAgents: ["memeloop:plan"],
  maxComplexity: 10, // 1-10 scale
  estimatedDuration: "medium", // "quick" | "medium" | "long"
};

export const exploreCategory: CategoryDefinition = {
  id: "explore",
  name: "Explore",
  description: "Codebase search and discovery",
  keywords: ["find", "search", "locate", "where", "discover", "list"],
  requiredTools: ["file.read", "grep.search", "glob.*", "lsp.*"],
  preferredAgents: ["memeloop:explore"],
  fallbackAgents: ["memeloop:oracle"],
  maxComplexity: 3,
  estimatedDuration: "quick",
};
```

### Registering Categories

```typescript
import { getCategoryRegistry } from "memeloop/categories";
import { buildCategory, exploreCategory } from "./categories/core";

const registry = getCategoryRegistry();

// Register built-in categories
registry.registerCategory(buildCategory);
registry.registerCategory(exploreCategory);

// Register custom category
registry.registerCategory({
  id: "custom:ml-pipeline",
  name: "ML Pipeline",
  description: "Machine learning model training and deployment",
  keywords: ["train", "model", "dataset", "inference", "deploy"],
  requiredTools: ["file.read", "terminal.exec", "web.fetch"],
  preferredAgents: ["myteam:ml-engineer"],
  skills: ["pytorch", "data-processing"],
});
```

### Agent Category Assignment

```typescript
import { getAgentRegistry } from "memeloop/agent/agentRegistry";

const agentRegistry = getAgentRegistry();
const buildAgent = agentRegistry.getAgent("memeloop:build");

if (buildAgent) {
  // Extend the agent definition with categories
  (buildAgent as any).categories = ["build", "quick", "refactoring"];
}

// Custom agent with categories
agentRegistry.registerAgent({
  id: "myteam:frontend-dev",
  name: "Frontend Developer",
  type: "build",
  prompt: "You are a frontend specialist...",
  permissions: { default: "allow", rules: [] },
  skills: ["react", "tailwind", "a11y"],
  categories: ["build", "visual-engineering", "writing"],
  protocolDef: {
    id: "myteam:frontend-dev",
    name: "Frontend Developer",
    description: "Frontend specialist",
    systemPrompt: "You are a frontend specialist...",
    tools: [],
    version: "1.0.0",
  },
});
```

### Skill Category Assignment

```typescript
import { getSkillRegistry } from "memeloop/skills";

const skillRegistry = getSkillRegistry();
skillRegistry.registerSkill({
  id: "react-component-generator",
  name: "React Component Generator",
  version: "1.0.0",
  description: "Generates TypeScript React components with props interfaces",
  category: "visual-engineering",
  instructions: "Generate React components using TypeScript and functional component syntax...",
  tools: ["file.write", "file.read"],
});
```

## Category-Based Task Routing

### Simple Keyword Router

```typescript
import { getCategoryRegistry } from "memeloop/categories";

function routeByKeywords(message: string): string[] {
  const registry = getCategoryRegistry();
  const categories = registry.listCategories();
  const lowerMsg = message.toLowerCase();

  const matches: Array<{ id: string; score: number }> = [];
  for (const cat of categories) {
    let score = 0;
    for (const keyword of cat.keywords) {
      if (lowerMsg.includes(keyword.toLowerCase())) {
        score += 1;
      }
    }
    if (score > 0) matches.push({ id: cat.id, score });
  }

  return matches
    .sort((a, b) => b.score - a.score)
    .map((m) => m.id);
}

// Usage
const categories = routeByKeywords("Find all usages of the auth hook and refactor them");
console.log(categories); // ["explore", "build", "refactoring"]
```

### Agent Resolver

```typescript
import { getAgentRegistry } from "memeloop/agent/agentRegistry";
import { getCategoryRegistry } from "memeloop/categories";

function resolveAgentsForCategories(categoryIds: string[]): string[] {
  const agentRegistry = getAgentRegistry();
  const categoryRegistry = getCategoryRegistry();
  const agents = agentRegistry.listAgents();

  const matched = new Set<string>();
  for (const agent of agents) {
    const agentCategories = (agent as any).categories ?? [agent.type];
    for (const catId of categoryIds) {
      const category = categoryRegistry.getCategory(catId);
      if (!category) continue;

      // Direct category match
      if (agentCategories.includes(catId)) {
        matched.add(agent.id);
      }
      // Preferred agent match
      if (category.preferredAgents?.includes(agent.id)) {
        matched.add(agent.id);
      }
    }
  }

  return Array.from(matched);
}

// Usage
const agentIds = resolveAgentsForCategories(["explore", "build"]);
console.log(agentIds); // ["memeloop:explore", "memeloop:build"]
```

### Multi-Agent Pipeline

```typescript
import { taskToolImpl } from "memeloop/tools/builtins/task";

async function executeCategorizedPipeline(message: string, context: any) {
  const categories = routeByKeywords(message);

  // Phase 1: Planning (if needed)
  const planCategory = categories.find((c) => c === "plan" || c === "ultrabrain");
  if (planCategory) {
    const planResult = await taskToolImpl(
      { agent: "memeloop:plan", prompt: `Plan: ${message}` },
      context,
    );
    console.log("Plan:", planResult.result);
  }

  // Phase 2: Exploration (if needed)
  const exploreCategory = categories.find((c) => c === "explore");
  if (exploreCategory) {
    const exploreResult = await taskToolImpl(
      { agent: "memeloop:explore", prompt: `Explore: ${message}` },
      context,
    );
    console.log("Exploration:", exploreResult.result);
  }

  // Phase 3: Execution
  const executionAgents = resolveAgentsForCategories(categories);
  const primaryAgent = executionAgents.find((id) => id === "memeloop:build") ?? executionAgents[0];

  if (primaryAgent) {
    const result = await taskToolImpl(
      { agent: primaryAgent, prompt: message },
      context,
    );
    return result;
  }

  return { error: "No suitable agent found for categories: " + categories.join(", ") };
}
```

## Category Configuration File

```yaml
# ~/.memeloop/categories.yaml
categories:
  - id: build
    name: Build
    keywords: [write, edit, create, generate, implement, fix]
    preferred_agents: [memeloop:build]
    fallback_agents: [memeloop:plan]

  - id: visual-engineering
    name: Visual Engineering
    keywords: [css, ui, layout, design, responsive, component]
    preferred_agents: [myteam:frontend-dev]
    skills: [react, tailwind]

  - id: ultrabrain
    name: Ultrabrain
    keywords: [design, architecture, research, analyze, compare]
    preferred_agents: [memeloop:plan, memeloop:oracle]
    max_complexity: 10
    estimated_duration: long

agents:
  memeloop:build:
    categories: [build, quick, refactoring]
  memeloop:explore:
    categories: [explore, quick]
  myteam:frontend-dev:
    categories: [build, visual-engineering, writing]

skills:
  react-component-generator:
    category: visual-engineering
  security-audit:
    category: oracle
```

## Category Registry API

```typescript
import { CategoryRegistry, getCategoryRegistry } from "memeloop/categories";

const registry = new CategoryRegistry();

// Register
registry.registerCategory({
  id: "testing",
  name: "Testing",
  description: "Test generation and execution",
  keywords: ["test", "spec", "coverage", "jest", "vitest"],
  preferredAgents: ["memeloop:build"],
  skills: ["api-testing", "unit-test-generation"],
});

// Retrieve
const cat = registry.getCategory("testing");
console.log(cat?.name); // "Testing"

// List all
const all = registry.listCategories();

// Find by keyword
const matches = registry.findByKeyword("test");
console.log(matches.map((c) => c.id)); // ["testing"]

// Reset to defaults
registry.reset();
```

## Testing Category Routing

```typescript
import { describe, it, expect } from "vitest";
import { CategoryRegistry } from "memeloop/categories";

describe("Category Routing", () => {
  it("matches keywords to categories", () => {
    const registry = new CategoryRegistry();
    registry.registerCategory({
      id: "build",
      name: "Build",
      keywords: ["write", "edit"],
    });

    const matches = registry.findByKeyword("write");
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe("build");
  });

  it("resolves agents for categories", () => {
    const catRegistry = new CategoryRegistry();
    catRegistry.registerCategory({
      id: "build",
      name: "Build",
      preferredAgents: ["memeloop:build"],
    });

    const agents = catRegistry.resolvePreferredAgents("build");
    expect(agents).toContain("memeloop:build");
  });
});
```

## Cloud Admin Category Management

```typescript
// memeloop-cloud admin API endpoints

// List categories
GET /api/categories
// Response:
{
  "categories": [
    { "id": "build", "name": "Build", "agentCount": 3, "skillCount": 5 },
    { "id": "explore", "name": "Explore", "agentCount": 2, "skillCount": 2 }
  ]
}

// Get category details
GET /api/categories/build
// Response:
{
  "id": "build",
  "name": "Build",
  "agents": ["memeloop:build", "myteam:frontend-dev"],
  "skills": ["refactoring", "code-generation", "react-component-generator"]
}

// Update category keywords
PATCH /api/categories/build
{
  "keywords": ["write", "edit", "create", "generate", "implement", "fix", "update"]
}
```

## Implementation Status

The category system is a **Phase 3 roadmap feature**. Current building blocks:

- `AgentRegistryEntry.skills` — Skills are typed but not runtime-resolved
- `AgentRegistryEntry.type` — Serves as an implicit single-category tag
- `memeloop-cloud/src/db.ts` — Database schema ready for category columns

### Planned Schema Extension

```typescript
// Planned addition to packages/memeloop/src/agent/agentTypes.ts

export interface AgentRegistryEntry {
  // ... existing fields
  categories?: string[]; // Category IDs for semantic routing
}

// Planned addition to packages/memeloop-cloud/src/db.ts

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    keywords TEXT DEFAULT '[]',
    preferred_agents TEXT DEFAULT '[]',
    skills TEXT DEFAULT '[]'
  );
`);
```

## Best Practices

1. **Use consistent category IDs** — Kebab-case IDs (`visual-engineering`, not `Visual Engineering`)
2. **Provide 5-10 keywords per category** — Enough for matching without excessive false positives
3. **Set fallback agents** — Always have a secondary agent if the primary is unavailable
4. **Match skill categories to agent categories** — Skills should be discoverable through the same categories as their host agents
5. **Limit pipeline depth** — Avoid chaining more than 3 category-based delegations
6. **Log routing decisions** — Record which categories were matched and why for debugging
