# Category System

The category system is a roadmap feature for semantic routing. It is not implemented in core `memeloop` today.

Current routing primitives are:

- built-in agent profile `type` values: `build`, `plan`, `explore`, `oracle`, `librarian`,
- explicit `task` tool delegation by profile id,
- host-provided agent definitions loaded from prompt JSON, node YAML, or remote RPC,
- host/cloud metadata outside the core runtime.

## Current Boundary

Core `memeloop` does not expose a category registry, category resolver, skill registry, or profile-level skills field. Those concepts are not part of the current core package.

If a host wants category routing now, keep it at the host layer and resolve categories to agent profile ids before calling the `task` tool.

```typescript
const profileByCategory: Record<string, string> = {
  build: "memeloop:build",
  plan: "memeloop:plan",
  explore: "memeloop:explore",
  oracle: "memeloop:oracle",
  librarian: "memeloop:librarian",
};

const agent = profileByCategory[category] ?? "memeloop:build";
await taskToolImpl({ agent, prompt }, context);
```

## Possible Future Shape

A future category system should define:

- persistent category metadata,
- category-to-profile resolution rules,
- conflict handling when multiple categories match,
- host/cloud ownership of category data,
- how category routing composes with per-profile permissions.

Until those semantics are stable, category routing remains outside core `memeloop`.
