import { describe, expect, it } from 'vitest';
import { runStorageConformance } from '../conformance.js';
import { TiddlyWikiHttpStorage } from '../tiddlyWikiHttpStorage.js';

/** Minimal in-memory TiddlyWiki server with ETag/CAS semantics. */
function createMockWikiServer() {
  const tiddlers = new Map<string, { tiddler: unknown; revision: number }>();

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const listMatch = /\/recipes\/([^/]+)\/tiddlers\.json$/.exec(url.pathname);
    if (listMatch) {
      const filter = url.searchParams.get('filter') ?? '';
      const prefixMatch = /\[prefix\["((?:\\.|[^"\\])*)"\]\]/.exec(filter);
      const prefix = (prefixMatch?.[1] ?? '').replace(/\\(.)/g, '$1');
      const matches = [...tiddlers.entries()]
        .filter(([title]) => title.startsWith(prefix))
        .map(([, entry]) => entry.tiddler);
      return new Response(JSON.stringify(matches), { status: 200 });
    }

    const titleMatch = /\/recipes\/([^/]+)\/tiddlers\/(.+)$/.exec(url.pathname);
    if (!titleMatch) return new Response('not found', { status: 404 });
    const title = decodeURIComponent(titleMatch[2]);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (method === 'GET') {
      const entry = tiddlers.get(title);
      if (!entry) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(entry.tiddler), {
        status: 200,
        headers: { etag: `"tiddler/${entry.revision}"` },
      });
    }

    if (method === 'PUT') {
      const current = tiddlers.get(title);
      const ifMatch = (init?.headers as Record<string, string> | undefined)?.['if-match'];
      if (ifMatch && current && ifMatch !== `"tiddler/${current.revision}"`) {
        return new Response('etag mismatch', { status: 412 });
      }
      const revision = (current?.revision ?? 0) + 1;
      tiddlers.set(title, { tiddler: JSON.parse(typeof init?.body === 'string' ? init.body : '{}'), revision });
      return new Response(null, { status: 204 });
    }

    return new Response('method not allowed', { status: 405 });
  };

  return { fetchImpl: fetchImpl as typeof fetch, tiddlers };
}

describe('TiddlyWikiHttpStorage', () => {
  it('passes the storage conformance suite', async () => {
    const server = createMockWikiServer();
    const storage = new TiddlyWikiHttpStorage({ baseUrl: 'http://wiki.local', fetchImpl: server.fetchImpl });
    const report = await runStorageConformance(storage, { conversationId: 'tw-conformance' });
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(report.checks);
  });

  it('retries CAS writes on 412 and succeeds with a fresh ETag', async () => {
    const server = createMockWikiServer();
    const first = new TiddlyWikiHttpStorage({ baseUrl: 'http://wiki.local', fetchImpl: server.fetchImpl });
    const second = new TiddlyWikiHttpStorage({ baseUrl: 'http://wiki.local', fetchImpl: server.fetchImpl });

    await first.upsertConversationMetadata({
      conversationId: 'c1',
      title: 'v1',
      lastMessagePreview: '',
      lastMessageTimestamp: 1,
      messageCount: 1,
      originNodeId: 'local',
      definitionId: 'agent',
      isUserInitiated: true,
    });

    // Concurrent writer bumps the revision; the first driver's next write must
    // re-read and retry rather than overwrite blindly.
    await Promise.all([
      first.upsertConversationMetadata({
        conversationId: 'c1',
        title: 'writer-a',
        lastMessagePreview: '',
        lastMessageTimestamp: 2,
        messageCount: 2,
        originNodeId: 'local',
        definitionId: 'agent',
        isUserInitiated: true,
      }),
      second.upsertConversationMetadata({
        conversationId: 'c1',
        title: 'writer-b',
        lastMessagePreview: '',
        lastMessageTimestamp: 3,
        messageCount: 3,
        originNodeId: 'local',
        definitionId: 'agent',
        isUserInitiated: true,
      }),
    ]);

    const meta = await first.getConversationMeta('c1');
    expect(['writer-a', 'writer-b']).toContain(meta?.title);
    // No torn write: exactly one revision chain exists.
    expect(server.tiddlers.get('$:/memeloop/meta/c1')?.revision).toBeGreaterThanOrEqual(2);
  });

  it('fails with CONFLICT when the CAS budget is exhausted', async () => {
    const server = createMockWikiServer();
    // Force every PUT to look stale by mutating between read and write.
    const originalRead = server.fetchImpl;
    let reads = 0;
    const racingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await originalRead(input, init);
      if ((init?.method ?? 'GET').toUpperCase() === 'GET') {
        reads += 1;
        if (reads > 1) {
          // Another writer lands between our GET and PUT.
          const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
          const titleMatch = /tiddlers\/(.+)$/.exec(url.pathname);
          if (titleMatch) {
            const title = decodeURIComponent(titleMatch[1]);
            const current = server.tiddlers.get(title);
            if (current) current.revision += 1;
          }
        }
      }
      return response;
    }) as typeof fetch;

    const racing = new TiddlyWikiHttpStorage({ baseUrl: 'http://wiki.local', fetchImpl: racingFetch, maxCasAttempts: 2 });
    await racing.upsertConversationMetadata({
      conversationId: 'c2',
      title: 'seed',
      lastMessagePreview: '',
      lastMessageTimestamp: 1,
      messageCount: 1,
      originNodeId: 'local',
      definitionId: 'agent',
      isUserInitiated: true,
    });

    await expect(racing.upsertConversationMetadata({
      conversationId: 'c2',
      title: 'update',
      lastMessagePreview: '',
      lastMessageTimestamp: 2,
      messageCount: 2,
      originNodeId: 'local',
      definitionId: 'agent',
      isUserInitiated: true,
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects oversized blobs with external-BlobStore guidance', async () => {
    const server = createMockWikiServer();
    const storage = new TiddlyWikiHttpStorage({ baseUrl: 'http://wiki.local', fetchImpl: server.fetchImpl, maxInlineBlobBytes: 8 });

    await expect(storage.saveAttachment(
      { contentHash: 'h1', filename: 'big.bin', mimeType: 'application/octet-stream', size: 16 },
      new Uint8Array(16),
    )).rejects.toMatchObject({ code: 'INVALID', message: expect.stringContaining('external BlobStore') });
  });

  it('sends basic-auth and bearer authorization headers', async () => {
    const seen: string[] = [];
    const server = createMockWikiServer();
    const recording = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string> | undefined)?.authorization ?? '');
      return server.fetchImpl(input, init);
    }) as typeof fetch;

    const basic = new TiddlyWikiHttpStorage({
      baseUrl: 'http://wiki.local',
      fetchImpl: recording,
      auth: { username: 'alice', password: 'secret' },
    });
    await basic.getConversationMeta('missing');
    expect(seen.at(-1)).toBe(`Basic ${btoa('alice:secret')}`);

    const bearer = new TiddlyWikiHttpStorage({
      baseUrl: 'http://wiki.local',
      fetchImpl: recording,
      auth: { token: 'tok-1' },
    });
    await bearer.getConversationMeta('missing');
    expect(seen.at(-1)).toBe('Bearer tok-1');
  });

  it('returns null for missing definitions and attachments', async () => {
    const server = createMockWikiServer();
    const storage = new TiddlyWikiHttpStorage({ baseUrl: 'http://wiki.local', fetchImpl: server.fetchImpl });
    await expect(storage.getAgentDefinition('nope')).resolves.toBeNull();
    await expect(storage.getAttachment('nope')).resolves.toBeNull();
    await expect(storage.readAttachmentData('nope')).resolves.toBeNull();
  });
});
