import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";

import {
  matchPattern,
  mergePermissionSets,
  checkPermission,
} from "../engine.js";
import {
  loadUserPermissions,
  saveUserPermissions,
  PERMISSIONS_TABLE_DDL,
} from "../storage.js";
import type { PermissionSet, MergedPermissions } from "../types.js";

// ─── matchPattern ────────────────────────────────────────────────

describe("matchPattern", () => {
  it("matches exact tool name", () => {
    expect(matchPattern("file.read", "file.read")).toBe(true);
    expect(matchPattern("file.read", "file.write")).toBe(false);
  });

  it("matches * wildcard (everything)", () => {
    expect(matchPattern("anything", "*")).toBe(true);
    expect(matchPattern("file.read", "*")).toBe(true);
    expect(matchPattern("", "*")).toBe(true);
  });

  it("matches prefix wildcard file.*", () => {
    expect(matchPattern("file.read", "file.*")).toBe(true);
    expect(matchPattern("file.write", "file.*")).toBe(true);
    expect(matchPattern("file", "file.*")).toBe(false);
    expect(matchPattern("terminal.run", "file.*")).toBe(false);
  });

  it("matches suffix wildcard *.read", () => {
    expect(matchPattern("file.read", "*.read")).toBe(true);
    expect(matchPattern("dir.read", "*.read")).toBe(true);
    expect(matchPattern("read", "*.read")).toBe(false);
  });

  it("matches wildcard in middle", () => {
    expect(matchPattern("shell(rm)", "shell(*)")).toBe(true);
    expect(matchPattern("shell(ls)", "shell(*)")).toBe(true);
    expect(matchPattern("shell", "shell(*)")).toBe(false);
  });

  it("handles special regex characters in tool name safely", () => {
    expect(matchPattern("file.txt", "file.txt")).toBe(true);
    expect(matchPattern("file+txt", "file+txt")).toBe(true);
    expect(matchPattern("path.to.tool", "path.*")).toBe(true);
  });

  it("handles empty inputs", () => {
    expect(matchPattern("", "")).toBe(true);
    expect(matchPattern("foo", "")).toBe(false);
    expect(matchPattern("", "foo")).toBe(false);
  });
});

// ─── mergePermissionSets ─────────────────────────────────────────

describe("mergePermissionSets", () => {
  it("returns empty merged permissions for empty input", () => {
    const result = mergePermissionSets([]);
    expect(result).toEqual<MergedPermissions>({ allow: [], deny: [], ask: [] });
  });

  it("single set produces correct flattened output", () => {
    const set: PermissionSet = {
      source: "test",
      rules: [
        { toolPattern: "file.*", action: "allow" },
        { toolPattern: "shell(*)", action: "deny" },
      ],
    };
    const result = mergePermissionSets([set]);
    expect(result.allow).toEqual(["file.*"]);
    expect(result.deny).toEqual(["shell(*)"]);
    expect(result.ask).toEqual([]);
  });

  it("later layer overrides earlier layer for same pattern", () => {
    const defaultSet: PermissionSet = {
      source: "default",
      rules: [{ toolPattern: "terminal.*", action: "deny" }],
    };
    const userSet: PermissionSet = {
      source: "user",
      rules: [{ toolPattern: "terminal.*", action: "allow" }],
    };
    const result = mergePermissionSets([defaultSet, userSet]);
    expect(result.allow).toContain("terminal.*");
    expect(result.deny).not.toContain("terminal.*");
  });

  it("within a single set, later rules override earlier ones", () => {
    const set: PermissionSet = {
      source: "test",
      rules: [
        { toolPattern: "*", action: "deny" },
        { toolPattern: "*", action: "allow" },
      ],
    };
    const result = mergePermissionSets([set]);
    expect(result.allow).toContain("*");
    expect(result.deny).not.toContain("*");
  });

  it("all four layers merge correctly (default → agent → user → session)", () => {
    const defaultSet: PermissionSet = {
      source: "default",
      rules: [
        { toolPattern: "*", action: "deny" },
        { toolPattern: "echo", action: "allow" },
      ],
    };
    const agentSet: PermissionSet = {
      source: "agent:my-agent",
      rules: [
        { toolPattern: "file.*", action: "allow" },
        { toolPattern: "file.delete", action: "ask" },
      ],
    };
    const userSet: PermissionSet = {
      source: "user",
      rules: [
        { toolPattern: "terminal.*", action: "allow" },
      ],
    };
    const sessionSet: PermissionSet = {
      source: "session",
      rules: [
        { toolPattern: "file.delete", action: "deny" },
      ],
    };

    const result = mergePermissionSets([defaultSet, agentSet, userSet, sessionSet]);

    // Default base: allow echo, deny everything else
    expect(result.allow).toContain("echo");

    // Agent: allows file.*; file.delete overridden by session to deny
    expect(result.allow).toContain("file.*");

    // User: allows terminal.*
    expect(result.allow).toContain("terminal.*");

    // Session: overrides file.delete from ask to deny
    expect(result.deny).toContain("file.delete");
    expect(result.ask).not.toContain("file.delete");
  });

  it("removes pattern from other action maps when overridden", () => {
    const s1: PermissionSet = {
      source: "first",
      rules: [{ toolPattern: "x", action: "allow" }],
    };
    const s2: PermissionSet = {
      source: "second",
      rules: [{ toolPattern: "x", action: "deny" }],
    };
    const result = mergePermissionSets([s1, s2]);
    expect(result.allow).not.toContain("x");
    expect(result.deny).toContain("x");
  });
});

// ─── checkPermission ─────────────────────────────────────────────

describe("checkPermission", () => {
  it("returns allow for unknown tool when nothing is restricted (backward compat)", () => {
    const merged: MergedPermissions = { allow: [], deny: [], ask: [] };
    expect(checkPermission("any.tool", merged)).toBe("allow");
  });

  it("returns allow for explicitly allowed pattern", () => {
    const merged: MergedPermissions = {
      allow: ["file.*"],
      deny: [],
      ask: [],
    };
    expect(checkPermission("file.read", merged)).toBe("allow");
  });

  it("returns deny for explicitly denied pattern", () => {
    const merged: MergedPermissions = {
      allow: ["*"],
      deny: ["terminal.execute"],
      ask: [],
    };
    expect(checkPermission("terminal.execute", merged)).toBe("deny");
  });

  it("deny takes precedence over allow for exact match", () => {
    const merged: MergedPermissions = {
      allow: ["file.delete"],
      deny: ["file.delete"],
      ask: [],
    };
    expect(checkPermission("file.delete", merged)).toBe("deny");
  });

  it("ask takes precedence over allow", () => {
    const merged: MergedPermissions = {
      allow: ["*"],
      deny: [],
      ask: ["shell(*)"],
    };
    expect(checkPermission("shell(rm)", merged)).toBe("ask");
  });

  it("deny takes precedence over ask for same specificity", () => {
    const merged: MergedPermissions = {
      allow: [],
      deny: ["terminal.*"],
      ask: ["terminal.*"],
    };
    expect(checkPermission("terminal.execute", merged)).toBe("deny");
  });

  it("returns deny when no pattern matches", () => {
    const merged: MergedPermissions = {
      allow: ["echo"],
      deny: [],
      ask: [],
    };
    expect(checkPermission("unknown.tool", merged)).toBe("deny");
  });

  it("wildcard allow matches any tool", () => {
    const merged: MergedPermissions = {
      allow: ["*"],
      deny: [],
      ask: [],
    };
    expect(checkPermission("anything.goes", merged)).toBe("allow");
    expect(checkPermission("also.this", merged)).toBe("allow");
  });
});

// ─── permission storage ──────────────────────────────────────────

describe("permission storage", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(PERMISSIONS_TABLE_DDL);
  });

  it("loadUserPermissions returns empty set when no data exists", () => {
    const result = loadUserPermissions(db);
    expect(result).toEqual<PermissionSet>({ rules: [], source: "user" });
  });

  it("loadUserPermissions returns empty set when table does not exist", () => {
    const freshDb = new Database(":memory:");
    const result = loadUserPermissions(freshDb);
    expect(result).toEqual<PermissionSet>({ rules: [], source: "user" });
  });

  it("saveUserPermissions persists and loadUserPermissions reads back", () => {
    const set: PermissionSet = {
      source: "user",
      rules: [
        { toolPattern: "file.*", action: "allow" },
        { toolPattern: "terminal.*", action: "ask" },
      ],
    };
    saveUserPermissions(db, set);

    const loaded = loadUserPermissions(db);
    expect(loaded.source).toBe("user");
    expect(loaded.rules).toHaveLength(2);
    expect(loaded.rules[0]).toEqual({ toolPattern: "file.*", action: "allow" });
    expect(loaded.rules[1]).toEqual({ toolPattern: "terminal.*", action: "ask" });
  });

  it("saveUserPermissions overwrites previous data (upsert)", () => {
    const set1: PermissionSet = {
      source: "user",
      rules: [{ toolPattern: "x", action: "allow" }],
    };
    saveUserPermissions(db, set1);

    const set2: PermissionSet = {
      source: "user",
      rules: [{ toolPattern: "y", action: "deny" }],
    };
    saveUserPermissions(db, set2);

    const loaded = loadUserPermissions(db);
    expect(loaded.rules).toHaveLength(1);
    expect(loaded.rules[0]).toEqual({ toolPattern: "y", action: "deny" });
  });
});

// ─── integration: full layered flow ──────────────────────────────

describe("layered permission integration", () => {
  it("default allow-all + user deny terminal → user wins", () => {
    const defaultSet: PermissionSet = {
      source: "default",
      rules: [{ toolPattern: "*", action: "allow" }],
    };
    const userSet: PermissionSet = {
      source: "user",
      rules: [{ toolPattern: "terminal.*", action: "deny" }],
    };
    const merged = mergePermissionSets([defaultSet, userSet]);

    expect(checkPermission("file.read", merged)).toBe("allow");
    expect(checkPermission("terminal.execute", merged)).toBe("deny");
  });

  it("default deny-all + session allow specific → session wins", () => {
    const defaultSet: PermissionSet = {
      source: "default",
      rules: [{ toolPattern: "*", action: "deny" }],
    };
    const sessionSet: PermissionSet = {
      source: "session",
      rules: [{ toolPattern: "echo", action: "allow" }],
    };
    const merged = mergePermissionSets([defaultSet, sessionSet]);

    expect(checkPermission("echo", merged)).toBe("allow");
    expect(checkPermission("anything", merged)).toBe("deny");
  });

  it("respects ask action through all layers", () => {
    const sets: PermissionSet[] = [
      {
        source: "default",
        rules: [{ toolPattern: "*", action: "allow" }],
      },
      {
        source: "agent:cli",
        rules: [{ toolPattern: "shell(*)", action: "ask" }],
      },
    ];
    const merged = mergePermissionSets(sets);

    expect(checkPermission("shell(rm)", merged)).toBe("ask");
    expect(checkPermission("file.read", merged)).toBe("allow");
  });
});
