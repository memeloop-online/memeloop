/**
 * Wiki manager using the tiddlywiki npm package: boot wiki from path, use Wiki API for get/set/list/search.
 * Types from tw5-typed (ITiddlerFields). Supports wikiSearch, editTiddler, listTiddlers, getTiddler.
 * Wiki folder must exist and contain tiddlywiki.info (e.g. created with `npx tiddlywiki <path> --init`).
 */
/// <reference types="tw5-typed" />

import type { AgentDefinition } from 'memeloop';
import fs from 'node:fs';
import path from 'node:path';
import type { ITiddlerFields } from 'tiddlywiki';

import type { AgentDefinitionYaml } from '../config.js';
import { normalizeAgentDefinition } from '../config.js';

export type TiddlerFields = ITiddlerFields;

/** Wiki tiddlers tagged with this are parsed as JSON {@link AgentDefinition}. */
export const MEMELOOP_AGENT_DEFINITION_TAG = '$:/tags/MemeLoop/AgentDefinition';

export interface IWikiManager {
  getTiddler(wikiId: string, title: string): Promise<ITiddlerFields | null>;
  setTiddler(wikiId: string, tiddler: ITiddlerFields): Promise<void>;
  listTiddlers(wikiId: string, filter?: { tag?: string; type?: string }): Promise<ITiddlerFields[]>;
  search(wikiId: string, query: string): Promise<ITiddlerFields[]>;
  /** Tiddlers with tag {@link MEMELOOP_AGENT_DEFINITION_TAG}：正文为 AgentDefinition JSON。 */
  listAgentDefinitionsFromWiki(wikiId: string): Promise<AgentDefinition[]>;
  /** 丢弃已 boot 的 Wiki 实例（文件变更后应在重新加载前调用）。 */
  clearWikiCache(wikiId?: string): void;
}

type TiddlyWikiInstance = {
  wiki: {
    getTiddler(title: string): { fields: ITiddlerFields } | undefined;
    addTiddler(tiddler: unknown): void;
    filterTiddlers(filter: string): string[];
  };
  Tiddler: new(fields: ITiddlerFields) => unknown;
  boot: { argv: string[]; boot: (callback?: (error?: Error) => void) => void };
};

async function loadTiddlyWikiBoot(): Promise<{ TiddlyWiki: () => TiddlyWikiInstance }> {
  // Use dynamic import so vitest can mock `tiddlywiki` in unit tests.
  const mod = (await import('tiddlywiki')) as { default?: { TiddlyWiki: () => TiddlyWikiInstance } } | { TiddlyWiki: () => TiddlyWikiInstance };
  const resolved = 'default' in mod && mod.default ? mod.default : mod;
  return resolved as { TiddlyWiki: () => TiddlyWikiInstance };
}

async function bootWiki(wikiPath: string): Promise<TiddlyWikiInstance> {
  const absolutePath = path.resolve(wikiPath);
  if (!fs.existsSync(absolutePath)) {
    return Promise.reject(new Error(`Wiki path does not exist: ${absolutePath}`));
  }
  const boot = await loadTiddlyWikiBoot();
  const $tw = boot.TiddlyWiki();
  $tw.boot.argv = [absolutePath, '--load'];
  return new Promise((resolve, reject) => {
    $tw.boot.boot((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve($tw);
    });
  });
}

function tiddlerToFields(tiddler: { fields: ITiddlerFields }, title: string): ITiddlerFields {
  const f = { ...tiddler.fields };
  if (!f.title) f.title = title;
  if (!f.type) f.type = 'text/vnd.tiddlywiki';
  return f;
}

export class TiddlyWikiWikiManager implements IWikiManager {
  private cache = new Map<string, Promise<TiddlyWikiInstance>>();

  constructor(private basePath: string) {}

  private wikiPath(wikiId: string): string {
    const resolved = path.resolve(this.basePath, wikiId);
    const base = path.resolve(this.basePath);
    if (!resolved.startsWith(base) && resolved !== base) {
      throw new Error('wikiId escapes base path');
    }
    return resolved;
  }

  private getWiki(wikiId: string): Promise<TiddlyWikiInstance> {
    let p = this.cache.get(wikiId);
    if (!p) {
      const wp = this.wikiPath(wikiId);
      p = bootWiki(wp);
      this.cache.set(wikiId, p);
    }
    return p;
  }

  clearWikiCache(wikiId?: string): void {
    if (wikiId === undefined) {
      this.cache.clear();
    } else {
      this.cache.delete(wikiId);
    }
  }

  async getTiddler(wikiId: string, title: string): Promise<ITiddlerFields | null> {
    const $tw = await this.getWiki(wikiId);
    const tiddler = $tw.wiki.getTiddler(title);
    if (!tiddler) return null;
    return tiddlerToFields(tiddler, title);
  }

  async setTiddler(wikiId: string, tiddler: ITiddlerFields): Promise<void> {
    const $tw = await this.getWiki(wikiId);
    const fields = { ...tiddler };
    if (!fields.title) fields.title = '';
    $tw.wiki.addTiddler(new $tw.Tiddler(fields));
  }

  async listTiddlers(
    wikiId: string,
    filter?: { tag?: string; type?: string },
  ): Promise<ITiddlerFields[]> {
    const $tw = await this.getWiki(wikiId);
    let filterString = '[all[tiddlers]!is[system]sort[title]]';
    if (filter?.tag) {
      filterString = `[all[tiddlers]!is[system]tag[${filter.tag}]sort[title]]`;
    } else if (filter?.type) {
      filterString = `[all[tiddlers]!is[system]type[${filter.type}]sort[title]]`;
    }
    const titles = $tw.wiki.filterTiddlers(filterString);
    const out: ITiddlerFields[] = [];
    for (const title of titles) {
      const tiddler = $tw.wiki.getTiddler(title);
      if (tiddler) out.push(tiddlerToFields(tiddler, title));
    }
    return out;
  }

  async search(wikiId: string, query: string): Promise<ITiddlerFields[]> {
    const $tw = await this.getWiki(wikiId);
    const escaped = query.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
    const filterString = `[all[tiddlers]!is[system]search:title,text,tags[${escaped}]]`;
    const titles = $tw.wiki.filterTiddlers(filterString);
    const out: ITiddlerFields[] = [];
    for (const title of titles) {
      const tiddler = $tw.wiki.getTiddler(title);
      if (tiddler) out.push(tiddlerToFields(tiddler, title));
    }
    return out;
  }

  async listAgentDefinitionsFromWiki(wikiId: string): Promise<AgentDefinition[]> {
    const all = await this.listTiddlers(wikiId);
    const out: AgentDefinition[] = [];
    for (const t of all) {
      const tags = t.tags;
      const hasTag = Array.isArray(tags) && tags.includes(MEMELOOP_AGENT_DEFINITION_TAG);
      if (!hasTag) continue;
      const text = typeof t.text === 'string' ? t.text : '';
      if (!text.trim()) continue;
      try {
        const raw = JSON.parse(text) as AgentDefinitionYaml;
        if (raw && typeof raw.id === 'string') {
          out.push(normalizeAgentDefinition(raw));
        }
      } catch {
        /* skip invalid JSON */
      }
    }
    return out;
  }
}
