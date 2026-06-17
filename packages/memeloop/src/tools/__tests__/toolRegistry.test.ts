import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

interface MockToolDefinition {
  toolId: string;
  configSchema?: unknown;
  llmToolSchemas?: unknown;
  displayName?: string;
  description?: string;
}

const mocks = vi.hoisted(() => ({
  defineTool: vi.fn((def: MockToolDefinition) => ({
    tool: vi.fn(),
    toolId: def.toolId,
    configSchema: def.configSchema,
    llmToolSchemas: def.llmToolSchemas,
    displayName: def.displayName ?? def.toolId,
    description: def.description ?? "",
  })),
  registerToolParameterSchema: vi.fn(),
}));

vi.mock("../defineTool.js", () => ({
  defineTool: (definition: MockToolDefinition) => mocks.defineTool(definition),
}));

vi.mock("../schemaRegistry.js", () => ({
  registerToolParameterSchema: (...parameters: unknown[]) => {
    mocks.registerToolParameterSchema(...parameters);
  },
}));

import {
  getAllToolDefinitions,
  getToolDefinition,
  registerToolDefinition,
} from "../toolRegistry.js";

describe("toolRegistry", () => {
  it("registerToolDefinition registers definition and schema metadata", () => {
    const def = registerToolDefinition({
      toolId: "t1",
      configSchema: z.object({ x: z.number() }),
      llmToolSchemas: undefined,
      displayName: "T1",
      description: "D",
    });

    expect(def.toolId).toBe("t1");
    expect(mocks.registerToolParameterSchema).toHaveBeenCalledWith(
      "t1",
      expect.any(Object),
      expect.objectContaining({ displayName: "T1", description: "D" }),
    );
    expect(getToolDefinition("t1")).toBeTruthy();
    expect(getAllToolDefinitions().has("t1")).toBe(true);
  });
});
