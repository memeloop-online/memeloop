/**
 * WebSearch Tool — Search the web using a configurable endpoint.
 *
 * Uses the `MEMELOOP_WEB_SEARCH_ENDPOINT` environment variable, falling back
 * to a simple DuckDuckGo HTML scraping approach when not configured.
 */
import { z } from "zod";



export const webSearchConfigSchema = z.object({
  query: z.string().min(1).describe("Search query string"),
  numResults: z.number().int().positive().max(50).optional().default(10),
  category: z
    .enum(["general", "news", "images", "videos"])
    .optional()
    .default("general"),
});

export const WEB_SEARCH_TOOL_ID = "webSearch";

function getSearchEndpoint(): string | undefined {
  try {
    return process.env["MEMELOOP_WEB_SEARCH_ENDPOINT"];
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
  numResults: number,
): Promise<SearchResult[]> {
  const url = new URL(endpoint);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(numResults));

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Search endpoint returned ${response.status}`);
  }
  const data = (await response.json()) as {
    results?: Array<{
      title?: string;
      url?: string;
      snippet?: string;
      link?: string;
    }>;
  };
  return (data.results ?? []).map((r) => ({
    title: r.title ?? "Untitled",
    url: r.url ?? r.link ?? "",
    snippet: r.snippet ?? "",
  }));
}

async function searchViaDuckDuckGo(
  query: string,
  numResults: number,
): Promise<SearchResult[]> {
  // Fallback: use DuckDuckGo HTML (no official API, returns basic HTML)
  try {
    const response = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    );
    const html = await response.text();

    // Simple regex-based extraction of result links and snippets
    const results: SearchResult[] = [];
    const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g;
    const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    const links: Array<{ url: string; title: string }> = [];
    const snippets: string[] = [];

    let linkMatch: RegExpExecArray | null;
    while ((linkMatch = linkRegex.exec(html)) !== null && links.length < numResults) {
      links.push({ url: linkMatch[1], title: linkMatch[2].trim() });
    }

    let snippetMatch: RegExpExecArray | null;
    while (
      (snippetMatch = snippetRegex.exec(html)) !== null &&
      snippets.length < numResults
    ) {
      snippets.push(
        snippetMatch[1].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim(),
      );
    }

    for (let i = 0; i < Math.min(links.length, snippets.length); i++) {
      results.push({
        title: links[i].title,
        url: links[i].url,
        snippet: snippets[i],
      });
    }

    return results;
  } catch {
    return [];
  }
}

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return "No results found.";
  }
  return results
    .map(
      (r, i) =>
        `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   ${r.snippet}`,
    )
    .join("\n\n");
}

export async function webSearchImpl(
  args: Record<string, unknown>,
  
): Promise<{ result: string } | { error: string }> {
  const parsed = webSearchConfigSchema.safeParse(args);
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Web search failed: ${message}` };
  }
}
