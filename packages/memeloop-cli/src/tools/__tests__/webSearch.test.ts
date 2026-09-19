import { afterEach, describe, expect, it, vi } from 'vitest';

import { webSearchImpl } from '../webSearch.js';

describe('webSearch bounded transports', () => {
  afterEach(() => {
    delete process.env['MEMELOOP_WEB_SEARCH_ENDPOINT'];
    vi.unstubAllGlobals();
  });

  it('parses a bounded custom endpoint response', async () => {
    process.env['MEMELOOP_WEB_SEARCH_ENDPOINT'] = 'https://search.example/api';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [{ title: 'Result', url: 'https://result.example', snippet: 'bounded' }],
        }),
        {
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(webSearchImpl({ query: 'meme loop', numResults: 1 })).resolves.toEqual({
      result: expect.stringContaining('https://result.example'),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://search.example/api?q=meme+loop&limit=1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('fails before reading a custom endpoint body declared over the hard cap', async () => {
    process.env['MEMELOOP_WEB_SEARCH_ENDPOINT'] = 'https://search.example/api';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('ignored', {
          headers: { 'content-length': String(2 * 1_024 * 1_024 + 1) },
        }),
      ),
    );

    await expect(webSearchImpl({ query: 'oversized' })).resolves.toEqual({
      error: 'Web search failed: response_too_large',
    });
  });

  it('contains a malformed or oversized fallback as no results', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new Uint8Array([0xC3, 0x28]),
        ),
      ),
    );

    await expect(webSearchImpl({ query: 'invalid utf8' })).resolves.toEqual({
      result: expect.stringContaining('No results found.'),
    });
  });
});
