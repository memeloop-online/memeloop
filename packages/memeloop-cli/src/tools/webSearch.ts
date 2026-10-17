/**
 * WebSearch Tool — Search the web using a configurable endpoint.
 *
 * Uses the `MEMELOOP_WEB_SEARCH_ENDPOINT` environment variable, falling back
 * to a simple DuckDuckGo HTML scraping approach when not configured.
 */
import { z } from 'zod';

import { fetchBoundedText } from './boundedResponseText.js';

const SEARCH_RESPONSE_MAXIMUM_BYTES = 2 * 1_024 * 1_024;
const SEARCH_TIMEOUT_MS = 30_000;

export const webSearchConfigSchema = z.object({
  query: z.string().min(1).describe('Search query string'),
  numResults: z.number().int().positive().max(50).optional().default(10),
  category: z
    .enum(['general', 'news', 'images', 'videos'])
    .optional()
    .default('general'),
});

export const WEB_SEARCH_TOOL_ID = 'webSearch';

function getSearchEndpoint(): string | undefined {
  try {
    return process.env['MEMELOOP_WEB_SEARCH_ENDPOINT'];
  } catch {
    return undefined;
  }
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchViaEndpoint(
  endpoint: string,
  query: string,
  numberResults: number,
): Promise<SearchResult[]> {
  const url = new URL(endpoint);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(numberResults));

  const { response, text } = await fetchBoundedText(url.toString(), {
    headers: { Accept: 'application/json' },
  }, {
    maximumBytes: SEARCH_RESPONSE_MAXIMUM_BYTES,
    timeoutMs: SEARCH_TIMEOUT_MS,
  });
  if (!response.ok) {
    throw new Error(`Search endpoint returned ${response.status}`);
  }
  const data = JSON.parse(text) as {
    results?: Array<{
      title?: string;
      url?: string;
      snippet?: string;
      link?: string;
    }>;
  };
  return (data.results ?? []).map((r) => ({
    title: r.title ?? 'Untitled',
    url: r.url ?? r.link ?? '',
    snippet: r.snippet ?? '',
  }));
}

async function searchViaDuckDuckGo(
  query: string,
  numberResults: number,
): Promise<SearchResult[]> {
  // Fallback: use DuckDuckGo HTML (no official API, returns basic HTML)
  try {
    const { text: html } = await fetchBoundedText(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      {},
      {
        maximumBytes: SEARCH_RESPONSE_MAXIMUM_BYTES,
        timeoutMs: SEARCH_TIMEOUT_MS,
      },
    );

    // Simple regex-based extraction of result links and snippets
    const results: SearchResult[] = [];
    const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g;
    const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    const links: Array<{ url: string; title: string }> = [];
    const snippets: string[] = [];

    let linkMatch: RegExpExecArray | null;
    while ((linkMatch = linkRegex.exec(html)) !== null && links.length < numberResults) {
      links.push({ url: linkMatch[1], title: linkMatch[2].trim() });
    }

    let snippetMatch: RegExpExecArray | null;
    while (
      (snippetMatch = snippetRegex.exec(html)) !== null &&
      snippets.length < numberResults
    ) {
      snippets.push(
        snippetMatch[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(),
      );
    }

    for (let index = 0; index < Math.min(links.length, snippets.length); index++) {
      results.push({
        title: links[index].title,
        url: links[index].url,
        snippet: snippets[index],
      });
    }

    return results;
  } catch {
    return [];
  }
}

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return 'No results found.';
  }
  return results
    .map(
      (r, index) => `${index + 1}. **${r.title}**\n   URL: ${r.url}\n   ${r.snippet}`,
    )
    .join('\n\n');
}

export async function webSearchImpl(
  arguments_: Record<string, unknown>,
): Promise<{ result: string } | { error: string }> {
  const parsed = webSearchConfigSchema.safeParse(arguments_);
  if (!parsed.success) {
    return { error: `invalid_webSearch_args: ${parsed.error.message}` };
  }

  const { query, numResults } = parsed.data;

  try {
    const endpoint = getSearchEndpoint();
    let results: SearchResult[];

    if (endpoint) {
      results = await searchViaEndpoint(endpoint, query, numResults);
    } else {
      results = await searchViaDuckDuckGo(query, numResults);
    }

    const formatted = formatResults(results);
    return { result: `Web search results for: "${query}"\n\n${formatted}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Web search failed: ${message}` };
  }
}
