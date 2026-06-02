import { describe, expect, it } from "vitest";

import { createFetchLLMProvider } from "../fetchProvider.js";

describe("createFetchLLMProvider", () => {
  it("returns an ILLMProvider placeholder with name and undefined model", () => {
    const provider = createFetchLLMProvider({
      name: "openai-like",
      baseUrl: "http://localhost:9999",
      apiKey: "sk-test",
    });
    expect(provider).toHaveProperty("name", "openai-like");
    expect(provider).toHaveProperty("model", undefined);
  });

  it("preserves the provider name from config entry", () => {
    const provider = createFetchLLMProvider({
      name: "siliconflow",
      baseUrl: "https://api.siliconflow.cn/v1",
      apiKey: "sk-test",
    });
    expect(provider.name).toBe("siliconflow");
  });

  it("model is always undefined (populated by caller via ai-sdk)", () => {
    const provider = createFetchLLMProvider({
      name: "test",
      baseUrl: "http://api",
      apiKey: "",
    });
    expect(provider.model).toBeUndefined();
  });
});
