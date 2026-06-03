import { describe, expect, it } from "vitest";

import { rjsfFieldPathToSegments, shouldShowConditionalField } from "../core/conditionVisibility.js";

describe("rjsfFieldPathToSegments", () => {
  it("parses nested array path without breaking property underscores", () => {
    expect(rjsfFieldPathToSegments("root_prompts_0_children_1")).toEqual(["prompts", "0", "children", "1"]);
  });

  it("parses property names that contain underscores", () => {
    expect(rjsfFieldPathToSegments("root_model_config_0")).toEqual(["model_config", "0"]);
  });

  it("parses dot-separated paths", () => {
    expect(rjsfFieldPathToSegments("root.model_config.max_tokens")).toEqual(["model_config", "max_tokens"]);
  });

  it("uses form data to disambiguate nested keys with underscores", () => {
    const root = { model_config: { mode: "basic" } };
    expect(
      rjsfFieldPathToSegments("root_model_config_max_tokens", root as Record<string, unknown>),
    ).toEqual(["model_config", "max_tokens"]);
  });

  it("prefers the longest key match when multiple keys share prefixes", () => {
    const root = { a: { b: 1 }, a_b: { c: 2 } };
    expect(rjsfFieldPathToSegments("root_a_b_c", root as any)).toEqual(["a_b", "c"]);
  });

  it("handles array index segments when current cursor is an array", () => {
    const root = { list: [{ x: 1 }, { x: 2 }] };
    expect(rjsfFieldPathToSegments("root_list_1_x", root as any)).toEqual(["list", "1", "x"]);
  });

  it("falls back to treating the rest as one segment when array index is missing", () => {
    const root = { list: [{ x: 1 }] };
    expect(rjsfFieldPathToSegments("root_list_x", root as any)).toEqual(["list", "x"]);
  });
});

describe("shouldShowConditionalField", () => {
  it("reads dependsOn from parent when field name has underscores", () => {
    const root = {
      model_config: { mode: "advanced" },
    };
    const show = shouldShowConditionalField(
      { dependsOn: "mode", showWhen: "advanced" },
      root as Record<string, unknown>,
      "root_model_config_max_tokens",
    );
    expect(show).toBe(true);
  });

  it("returns true when condition/rootFormData missing (no gating)", () => {
    expect(shouldShowConditionalField(undefined, undefined, undefined)).toBe(true);
    expect(shouldShowConditionalField({ dependsOn: "x", showWhen: "1" }, undefined, "root_a")).toBe(true);
  });

  it("supports showWhen array and hideWhen inversion", () => {
    const root = { cfg: { mode: "b" } };
    expect(
      shouldShowConditionalField(
        { dependsOn: "mode", showWhen: ["a", "b"] },
        root as any,
        "root_cfg_value",
      ),
    ).toBe(true);

    expect(
      shouldShowConditionalField(
        { dependsOn: "mode", showWhen: ["a", "b"], hideWhen: true },
        root as any,
        "root_cfg_value",
      ),
    ).toBe(false);
  });

  it("returns false when dependent value doesn't match (and hideWhen=false)", () => {
    const root = { cfg: { mode: "x" } };
    expect(
      shouldShowConditionalField(
        { dependsOn: "mode", showWhen: "y" },
        root as any,
        "root_cfg_value",
      ),
    ).toBe(false);
  });

  it("treats missing/invalid parent as undefined dependent value", () => {
    const root = { cfg: "not-object" };
    expect(
      shouldShowConditionalField(
        { dependsOn: "mode", showWhen: "y" },
        root as any,
        "root_cfg_value",
      ),
    ).toBe(false);
  });
});
