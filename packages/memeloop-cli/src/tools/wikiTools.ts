/**
 * Wiki tools for Agent: knowledge.wikiSearch, knowledge.editTiddler, knowledge.listTiddlers, knowledge.getTiddler.
 */

import type { IToolRegistry } from 'memeloop';
import type { IWikiManager } from '../knowledge/wikiManager.js';

const WIKI_SEARCH_ID = 'knowledge.wikiSearch';
const WIKI_EDIT_ID = 'knowledge.editTiddler';
const WIKI_LIST_ID = 'knowledge.listTiddlers';
const WIKI_GET_ID = 'knowledge.getTiddler';
const WIKI_BACKLINKS_ID = 'knowledge.backlinks';
const WIKI_TOC_ID = 'knowledge.toc';
const WIKI_RECENT_ID = 'knowledge.recent';
const WIKI_OPERATION_ID = 'knowledge.wikiOperation';
const WIKI_PLUGIN_ID = 'knowledge.tiddlywikiPlugin';
const WIKI_WORKSPACES_ID = 'knowledge.workspacesList';

export function registerWikiTools(
  registry: IToolRegistry,
  wikiManager: IWikiManager,
  defaultWikiId: string = 'default',
): void {
  registry.registerTool(WIKI_SEARCH_ID, (arguments_: Record<string, unknown>) => searchImpl(arguments_, wikiManager, defaultWikiId));
  registry.registerTool(WIKI_EDIT_ID, (arguments_: Record<string, unknown>) => editImpl(arguments_, wikiManager, defaultWikiId));
  registry.registerTool(WIKI_LIST_ID, (arguments_: Record<string, unknown>) => listImpl(arguments_, wikiManager, defaultWikiId));
  registry.registerTool(WIKI_GET_ID, (arguments_: Record<string, unknown>) => getImpl(arguments_, wikiManager, defaultWikiId));
  registry.registerTool(WIKI_BACKLINKS_ID, (arguments_: Record<string, unknown>) => backlinksImpl(arguments_, wikiManager, defaultWikiId));
  registry.registerTool(WIKI_TOC_ID, (arguments_: Record<string, unknown>) => tocImpl(arguments_, wikiManager, defaultWikiId));
  registry.registerTool(WIKI_RECENT_ID, (arguments_: Record<string, unknown>) => recentImpl(arguments_, wikiManager, defaultWikiId));
  registry.registerTool(WIKI_OPERATION_ID, (arguments_: Record<string, unknown>) => wikiOperationImpl(arguments_, wikiManager, defaultWikiId));
  registry.registerTool(WIKI_PLUGIN_ID, (arguments_: Record<string, unknown>) => pluginImpl(arguments_, wikiManager, defaultWikiId));
  registry.registerTool(WIKI_WORKSPACES_ID, (arguments_: Record<string, unknown>) => workspacesListImpl(arguments_, wikiManager, defaultWikiId));
}

async function searchImpl(
  arguments_: Record<string, unknown>,
  manager: IWikiManager,
  defaultWikiId: string,
): Promise<unknown> {
  const wikiId = (arguments_.wikiId as string) ?? defaultWikiId;
  const query = arguments_.query as string | undefined;
  if (!query || typeof query !== 'string') {
    return { error: "Missing 'query'. Example: { query: 'keyword', wikiId?: " + defaultWikiId + ' }' };
  }
  try {
    const tiddlers = await manager.search(wikiId, query);
    return { query, wikiId, count: tiddlers.length, tiddlers: tiddlers.map((t) => ({ title: t.title, type: t.type, tags: t.tags })) };
  } catch (error) {
    return { error: String(error) };
  }
}

async function editImpl(
  arguments_: Record<string, unknown>,
  manager: IWikiManager,
  defaultWikiId: string,
): Promise<unknown> {
  const wikiId = (arguments_.wikiId as string) ?? defaultWikiId;
  const title = arguments_.title as string | undefined;
  const text = arguments_.text as string | undefined;
  const type = (arguments_.type as string) ?? 'text/vnd.tiddlywiki';
  const tags = arguments_.tags as string | undefined;
  if (!title || typeof title !== 'string') {
    return { error: "Missing 'title'. Example: { title: 'My Tiddler', text?: '...', type?, tags?, wikiId? }" };
  }
  try {
    const tagsArray = tags == null || tags === ''
      ? undefined
      : typeof tags === 'string'
      ? tags.split(/[\s,]+/).filter(Boolean)
      : Array.isArray(tags)
      ? tags
      : undefined;
    await manager.setTiddler(wikiId, {
      title,
      text: text ?? '',
      type,
      ...(tagsArray?.length ? { tags: tagsArray } : {}),
    });
    return { ok: true, wikiId, title };
  } catch (error) {
    return { error: String(error) };
  }
}

async function listImpl(
  arguments_: Record<string, unknown>,
  manager: IWikiManager,
  defaultWikiId: string,
): Promise<unknown> {
  const wikiId = (arguments_.wikiId as string) ?? defaultWikiId;
  const tag = arguments_.tag as string | undefined;
  const type = arguments_.type as string | undefined;
  try {
    const tiddlers = await manager.listTiddlers(wikiId, tag ? { tag } : type ? { type } : undefined);
    return { wikiId, count: tiddlers.length, tiddlers: tiddlers.map((t) => ({ title: t.title, type: t.type, tags: t.tags })) };
  } catch (error) {
    return { error: String(error) };
  }
}

async function getImpl(
  arguments_: Record<string, unknown>,
  manager: IWikiManager,
  defaultWikiId: string,
): Promise<unknown> {
  const wikiId = (arguments_.wikiId as string) ?? defaultWikiId;
  const title = arguments_.title as string | undefined;
  if (!title || typeof title !== 'string') {
    return { error: "Missing 'title'. Example: { title: 'My Tiddler', wikiId? }" };
  }
  try {
    const tiddler = await manager.getTiddler(wikiId, title);
    if (!tiddler) return { found: false, wikiId, title };
    return { found: true, wikiId, tiddler };
  } catch (error) {
    return { error: String(error) };
  }
}

async function backlinksImpl(arguments_: Record<string, unknown>, manager: IWikiManager, defaultWikiId: string): Promise<unknown> {
  const wikiId = (arguments_.wikiId as string) ?? defaultWikiId;
  const title = arguments_.title as string | undefined;
  if (!title) return { error: "Missing 'title'" };
  const all = await manager.listTiddlers(wikiId);
  const linksTo = `[[${title}]]`;
  const tiddlers = all
    .filter((t) => typeof t.text === 'string' && t.text.includes(linksTo))
    .map((t) => ({ title: t.title, type: t.type, tags: t.tags }));
  return { wikiId, title, count: tiddlers.length, tiddlers };
}

async function tocImpl(arguments_: Record<string, unknown>, manager: IWikiManager, defaultWikiId: string): Promise<unknown> {
  const wikiId = (arguments_.wikiId as string) ?? defaultWikiId;
  const prefix = (arguments_.prefix as string) ?? '';
  const all = await manager.listTiddlers(wikiId);
  const tiddlers = all
    .filter((t) => typeof t.title === 'string' && (prefix ? t.title.startsWith(prefix) : true))
    .map((t) => ({ title: t.title, tags: t.tags, modified: t.modified }))
    .sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
  return { wikiId, count: tiddlers.length, tiddlers };
}

async function recentImpl(arguments_: Record<string, unknown>, manager: IWikiManager, defaultWikiId: string): Promise<unknown> {
  const wikiId = (arguments_.wikiId as string) ?? defaultWikiId;
  const limit = Math.max(1, Math.min(100, Number(arguments_.limit ?? 20)));
  const all = await manager.listTiddlers(wikiId);
  const tiddlers = (all as { title: string; modified: string }[])
    .map((t) => ({ title: t.title, modified: t.modified ?? '' }))
    .sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? ''))
    .slice(0, limit);
  return { wikiId, count: tiddlers.length, tiddlers };
}

async function wikiOperationImpl(
  arguments_: Record<string, unknown>,
  manager: IWikiManager,
  defaultWikiId: string,
): Promise<unknown> {
  const wikiId = (arguments_.wikiId as string) ?? defaultWikiId;
  const action = (arguments_.action as string) ?? 'get';
  const title = arguments_.title as string | undefined;
  if (action === 'get' && title) return getImpl({ wikiId, title }, manager, defaultWikiId);
  if (action === 'set' && title) return editImpl(arguments_, manager, defaultWikiId);
  if (action === 'search') return searchImpl(arguments_, manager, defaultWikiId);
  if (action === 'list') return listImpl(arguments_, manager, defaultWikiId);
  return { error: 'Unsupported action. Use get|set|search|list' };
}

async function pluginImpl(arguments_: Record<string, unknown>, manager: IWikiManager, defaultWikiId: string): Promise<unknown> {
  const wikiId = (arguments_.wikiId as string) ?? defaultWikiId;
  const list = await manager.listTiddlers(wikiId, { type: 'application/json' });
  const plugins = list
    .filter((t) => (t.title ?? '').startsWith('$:/plugins/'))
    .map((t) => ({ title: t.title, version: t.version, author: t.author }));
  return { wikiId, count: plugins.length, plugins };
}

async function workspacesListImpl(
  _arguments: Record<string, unknown>,
  _manager: IWikiManager,
  defaultWikiId: string,
): Promise<unknown> {
  return { workspaces: [{ wikiId: defaultWikiId, title: defaultWikiId }] };
}
