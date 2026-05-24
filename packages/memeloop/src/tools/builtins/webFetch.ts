/**
 * WebFetch Tool — Fetch URL content and return as markdown/text.
 *
 * Fetches a URL and returns its content. Supports formats: text, markdown, html.
 */
import { z } from "zod";

import type { BuiltinToolContext } from "./types.js";

export const webFetchConfigSchema = z.object({
  url: z.string().url().min(1).describe("The URL to fetch content from"),
  format: z
    .enum(["text", "markdown", "html"])
    .optional()
    .default("text")
    .describe("Output format: text, markdown, or html"),
  timeout: z
    .number()
    .int()
    .positive()
    .max(120_000)
    .optional()
    .describe("Request timeout in milliseconds"),
});

export const WEB_FETCH_TOOL_ID = "webFetch";

function htmlToText(html: string): string {
  // Simple HTML-to-text conversion: strip tags
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlToMarkdown(html: string): string {
  // Very simple HTML-to-markdown conversion
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "# $1\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "## $1\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "### $1\n")
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "#### $1\n")
    .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "##### $1\n")
    .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "###### $1\n")
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**")
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "*$1*")
    .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "*$1*")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "```\n$1\n```\n")
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
    .replace(/<p[^>]*>/g, "\n")
    .replace(/<\/p>/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function webFetchImpl(
  args: Record<string, unknown>,
  _ctx: BuiltinToolContext,
): Promise<{ result: string } | { error: string }> {
  const parsed = webFetchConfigSchema.safeParse(args);
  if (!parsed.success) {
    return { error: `invalid_webFetch_args: ${parsed.error.message}` };
  }

  const { url, format, timeout } = parsed.data;

  try {
    const controller = new AbortController();
    const timer = timeout ? setTimeout(() => controller.abort(), timeout) : undefined;

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "MemeLoop/1.0 (WebFetch Tool; +https://github.com/memeloop/memeloop)",
      },
      redirect: "follow",
    });

    if (timer) clearTimeout(timer);

    const contentType = response.headers.get("content-type") ?? "";
    const html = await response.text();

    let content: string;
    if (format === "html") {
      content = html;
    } else if (format === "markdown") {
      content = htmlToMarkdown(html);
    } else {
      content = htmlToText(html);
    }

    // Truncate large results
    const MAX_LENGTH = 100_000;
    const truncated =
      content.length > MAX_LENGTH
        ? content.slice(0, MAX_LENGTH) +
          `\n\n[... truncated at ${MAX_LENGTH} characters, total was ${content.length}]`
        : content;

    return {
      result: `Fetched: ${url}\nStatus: ${response.status}\nContent-Type: ${contentType}\n\n${truncated}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if ((err as Error).name === "AbortError") {
      return { error: `Web fetch timed out for ${url}` };
    }
    return { error: `Web fetch failed for ${url}: ${message}` };
  }
}
