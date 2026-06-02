import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TiddlyWikiWikiManager } from "../wikiManager.js";

// wikiManager uses `require("tiddlywiki")` lazily inside bootWiki().
// We provide a stable mock entry point and override the instance per test via globalThis.
const twState = vi.hoisted(() => ({ instance: null as any }));
vi.mock("tiddlywiki", () => ({
  default: { TiddlyWiki: () => twState.instance },
  TiddlyWiki: () => twState.instance,
}));

type Fields = Record<string, unknown> & { title?: string; type?: string; text?: string; tags?: any };

function makeMockTiddlyWiki(args: {
  getTiddlerMap: Record<string, Fields | undefined>;
  filterTiddlersImpl: (filterStr: string) => string[];
  boot: { bootCb?: (err?: Error) => void };
}) {
  const { getTiddlerMap, filterTiddlersImpl } = args;
  const wiki = {
    getTiddler: (title: string) => {
      const v = getTiddlerMap[title];
      if (!v) return undefined;
      return { fields: v as any };
    },
    addTiddler: vi.fn(),
    filterTiddlers: (filterStr: string) => {
      return filterTiddlersImpl(filterStr);
    },
  };

  class Tiddler {
    fields: Fields;
    constructor(fields: Fields) {
      this.fields = fields;
    }
  }

  const instance = {
    wiki,
    Tiddler,
    boot: {
      argv: [] as string[],
      boot: (cb?: (err?: Error) => void) => {
        cb?.();
        args.boot.bootCb?.();
      },
    },
  };

  return { instance, wiki };
}

describe("wikiManager", () => {
  const tmpDirs: string[] = [];
  let basePath = "";

  beforeEach(() => {
    basePath = fs.mkdtempSync(path.join(os.tmpdir(), "memeloop-wiki-"));
    tmpDirs.push(basePath);
  });

  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("boots wiki, caches, and supports get/set/list/search/agentDefinitions", async () => {
    const wikiId = "default";
    const wikiDir = path.join(basePath, wikiId);
    fs.mkdirSync(wikiDir, { recursive: true });

    const getTiddlerMap: Record<string, Fields | undefined> = {
      "t1": { title: "t1", type: "text/plain", tags: ["tag1"], text: "hello", modified: "2026-01-01" },
      "t2": { title: "t2", type: "text/plain", tags: ["$:/tags/MemeLoop/AgentDefinition"], text: JSON.stringify({ id: "agent-x" }), modified: "2026-02-01" },
      "invalid": { title: "invalid", type: "text/plain", tags: ["$:/tags/MemeLoop/AgentDefinition"], text: "not-json", modified: "2026-03-01" },
    };

    let bootCount = 0;
    const mock = makeMockTiddlyWiki({
      getTiddlerMap,
      filterTiddlersImpl: (filterStr) => {
        if (filterStr.includes("tag[")) return ["t1"];
        if (filterStr.includes("type[")) return ["t1"];
        if (filterStr.includes("search:title,text")) return ["t1"];
        return ["t1", "t2", "invalid"];
      },
      boot: {
        bootCb: () => {
          bootCount += 1;
        },
      },
    });

    twState.instance = mock.instance as any;

    const manager = new TiddlyWikiWikiManager(basePath);

    // getTiddler found / not found
    const t1 = await manager.getTiddler(wikiId, "t1");
    expect(t1?.title).toBe("t1");

    const missing = await manager.getTiddler(wikiId, "missing");
    expect(missing).toBeNull();

    // setTiddler defaults title to "" when missing (branch)
    await manager.setTiddler(wikiId, { text: "x", type: "text/plain", tags: [] } as any);
    expect((mock.wiki.addTiddler as any).mock.calls.length).toBe(1);

    // listTiddlers branches: default/tag/type
    await manager.listTiddlers(wikiId);
    const listTag = await manager.listTiddlers(wikiId, { tag: "tag1" });
    expect(listTag.length).toBe(1);
    const listType = await manager.listTiddlers(wikiId, { type: "text/plain" });
    expect(listType.length).toBe(1);

    // search escapes `]` / `\`
    const res = await manager.search(wikiId, "a]b\\c");
    expect(res.length).toBeGreaterThan(0);

    // listAgentDefinitionsFromWiki parses valid JSON only
    const agents = await manager.listAgentDefinitionsFromWiki(wikiId);
    expect(agents.map((a) => a.id)).toEqual(["agent-x"]);

    // clearWikiCache(wikiId) and cache reload
    expect(bootCount).toBeGreaterThan(0);
    const before = bootCount;
    manager.clearWikiCache(wikiId);
    await manager.getTiddler(wikiId, "t1");
    expect(bootCount).toBeGreaterThan(before);

    // clearWikiCache() clears all
    manager.clearWikiCache();
    await manager.getTiddler(wikiId, "t1");
  });

  it("rejects wikiId path escaping base directory", async () => {
    fs.mkdirSync(path.join(basePath, "safe"), { recursive: true });

    twState.instance = {
      wiki: { getTiddler: () => undefined, addTiddler: () => {}, filterTiddlers: () => [] },
      Tiddler: class {},
      boot: { argv: [], boot: (cb?: any) => cb?.() },
    };

    const manager = new TiddlyWikiWikiManager(basePath);
    await expect(manager.getTiddler("../evil", "x")).rejects.toThrow("wikiId escapes base path");
  });
});

