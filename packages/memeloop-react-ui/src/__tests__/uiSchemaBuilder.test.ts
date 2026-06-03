import { describe, expect, it } from "vitest";

import { buildUiSchema } from "../core/uiSchemaBuilder.js";

describe("buildUiSchema", () => {
  it("returns overrides when schema is undefined/null", () => {
    expect(buildUiSchema(undefined, { a: 1 } as any)).toEqual({ a: 1 });
    expect(buildUiSchema(null, { a: 1 } as any)).toEqual({ a: 1 });
  });

  it("merges schema.uiSchema with overrides (overrides win)", () => {
    const ui = buildUiSchema(
      {
        uiSchema: { "ui:order": ["b", "a"], a: { "ui:placeholder": "x" } } as any,
      },
      { a: { "ui:placeholder": "y" } } as any,
    );

    expect(ui["ui:order"]).toEqual(["b", "a"]);
    expect((ui as any).a["ui:placeholder"]).toBe("y");
  });
});

