import { describe, expect, it, vi } from 'vitest';

import { registerWikiTools } from '../wikiTools.js';

type ToolHandler = (args: Record<string, unknown>) => unknown;

function createRegistry() {
  const handlers = new Map<string, ToolHandler>();
  return {
    handlers,
    registry: {
      registerTool(id: string, handler: ToolHandler) {
        handlers.set(id, handler);
      },
    },
  };
}

function createWikiManager() {
  return {
    search: async (wikiId: string, query: string) => [{ title: `${wikiId}-${query}`, type: 'text/plain', tags: ['a'] }],
    setTiddler: async () => undefined,
    listTiddlers: async () => [
      { title: 'A', type: 'application/json', tags: ['x'], text: 'see [[B]]', modified: '2026-01-01' },
      { title: 'B', type: 'text/vnd.tiddlywiki', tags: ['y'], text: '', modified: '2026-02-01' },
      { title: '$:/plugins/demo/test', type: 'application/json', tags: [], version: '1.0.0', author: 'me' },
    ],
    getTiddler: async (_wikiId: string, title: string) => (title === 'missing' ? null : { title, text: 'content' }),
  };
}

describe('registerWikiTools', () => {
  it('registers all knowledge tools and routes to default wiki', async () => {
    const { registry, handlers } = createRegistry();
    const manager = createWikiManager();
    registerWikiTools(registry as never, manager as never, 'defaultWiki');

    expect(handlers.size).toBe(10);

    const search = await handlers.get('knowledge.wikiSearch')!({ query: 'hello' });
    expect(search).toMatchObject({ wikiId: 'defaultWiki', count: 1 });

    const getFound = await handlers.get('knowledge.getTiddler')!({ title: 'A' });
    expect(getFound).toMatchObject({ found: true, wikiId: 'defaultWiki' });
  });

  it('validates required fields and supports operation switch', async () => {
    const { registry, handlers } = createRegistry();
    const manager = createWikiManager();
    registerWikiTools(registry as never, manager as never, 'd');

    const get = await handlers.get('knowledge.getTiddler')!({});
    expect(get).toMatchObject({ error: expect.stringContaining("Missing 'title'") });

    const edit = await handlers.get('knowledge.editTiddler')!({ title: 'Doc', text: 'x', tags: 'a,b c' });
    expect(edit).toMatchObject({ ok: true, title: 'Doc' });

    const op = await handlers.get('knowledge.wikiOperation')!({ action: 'get', title: 'Doc' });
    expect(op).toMatchObject({ found: true, wikiId: 'd' });

    const unsupported = await handlers.get('knowledge.wikiOperation')!({ action: 'noop' });
    expect(unsupported).toMatchObject({ error: expect.stringContaining('Unsupported action') });
  });

  it('returns backlinks/toc/recent/plugins/workspaces payloads', async () => {
    const { registry, handlers } = createRegistry();
    const manager = createWikiManager();
    registerWikiTools(registry as never, manager as never, 'wk');

    const backlinks = await handlers.get('knowledge.backlinks')!({ title: 'B' });
    expect(backlinks).toMatchObject({ count: 1, title: 'B' });

    const toc = await handlers.get('knowledge.toc')!({ prefix: 'A' });
    expect(toc).toMatchObject({ count: 1 });

    const recent = await handlers.get('knowledge.recent')!({ limit: 1 });
    expect(recent).toMatchObject({ count: 1 });

    const plugins = await handlers.get('knowledge.tiddlywikiPlugin')!({});
    expect(plugins).toMatchObject({ count: 1 });

    const workspaces = await handlers.get('knowledge.workspacesList')!({});
    expect(workspaces).toEqual({ workspaces: [{ wikiId: 'wk', title: 'wk' }] });
  });

  it('covers search/list/get/edit validation and error branches', async () => {
    const { registry, handlers } = createRegistry();

    const listTiddlersSpy = vi.fn(async (_wikiId: string, filter?: any) => {
      // Return different sizes for tag/type/undefined filters to make assertions meaningful.
      if (filter?.tag) return [{ title: 'tagged', type: 't', tags: [] as any[], modified: 'm', text: '' }];
      if (filter?.type) return [{ title: 'typed', type: filter.type, tags: [] as any[], modified: 'm', text: '' }];
      return [{ title: 'all', type: 't', tags: [] as any[], modified: 'm', text: '' }];
    });

    const manager = {
      search: vi.fn(async () => {
        throw new Error('boom');
      }),
      setTiddler: vi.fn(async () => undefined),
      listTiddlers: listTiddlersSpy,
      getTiddler: vi.fn(async (_wikiId: string, title: string) => (title === 'missing' ? null : { title, text: 'content' })),
    } as any;

    registerWikiTools(registry as never, manager as never, 'wk');

    // searchImpl: missing query -> error
    const searchMissing = await handlers.get('knowledge.wikiSearch')!({ wikiId: 'wk' });
    expect(searchMissing).toMatchObject({ error: expect.stringContaining("Missing 'query'") });

    // searchImpl: manager.search throw -> error bubble
    const searchErr = await handlers.get('knowledge.wikiSearch')!({ wikiId: 'wk', query: 'x' });
    expect(searchErr).toMatchObject({ error: 'Error: boom' });

    // listImpl: tag branch
    const listTag = await handlers.get('knowledge.listTiddlers')!({ wikiId: 'wk', tag: 'a' });
    expect(listTag).toMatchObject({ count: 1, wikiId: 'wk' });
    expect(listTag).toMatchObject({ tiddlers: [{ title: 'tagged' }] });

    // listImpl: type branch
    const listType = await handlers.get('knowledge.listTiddlers')!({ wikiId: 'wk', type: 'application/json' });
    expect(listType).toMatchObject({ tiddlers: [{ title: 'typed' }] });

    // listImpl: neither -> undefined filter branch
    const listAll = await handlers.get('knowledge.listTiddlers')!({ wikiId: 'wk' });
    expect(listAll).toMatchObject({ tiddlers: [{ title: 'all' }] });

    // getImpl: not found branch
    const getNotFound = await handlers.get('knowledge.getTiddler')!({ wikiId: 'wk', title: 'missing' });
    expect(getNotFound).toMatchObject({ found: false, wikiId: 'wk', title: 'missing' });

    // editImpl: tags empty string => tagsArr undefined => no `tags` field in manager.setTiddler payload
    const edit = await handlers.get('knowledge.editTiddler')!({
      wikiId: 'wk',
      title: 'Doc',
      text: 'x',
      tags: '',
    });
    expect(edit).toMatchObject({ ok: true, title: 'Doc' });
    const editPayload = manager.setTiddler.mock.calls[0][1];
    expect(editPayload.tags).toBeUndefined();
  });

  it('covers wikiOperation title-gated branches and recent limit clamp', async () => {
    const { registry, handlers } = createRegistry();
    const manager = createWikiManager();
    registerWikiTools(registry as never, manager as never, 'wk');

    // get action without title => unsupported action branch (falls through)
    const opNoTitle = await handlers.get('knowledge.wikiOperation')!({ action: 'get' });
    expect(opNoTitle).toMatchObject({ error: expect.stringContaining('Unsupported action') });

    // recentImpl: clamp lower bound (limit 0 => 1)
    const recent1 = await handlers.get('knowledge.recent')!({ wikiId: 'wk', limit: 0 });
    expect(recent1).toMatchObject({ count: 1 });

    // recentImpl: clamp upper bound (limit 999 => 100)
    const recent100 = await handlers.get('knowledge.recent')!({ wikiId: 'wk', limit: 999 });
    // createWikiManager returns 3 tiddlers, so even though clamp becomes 100, count stays <=3
    expect(recent100).toMatchObject({ count: 3 });
  });
});
