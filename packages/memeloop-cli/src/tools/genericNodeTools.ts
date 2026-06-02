import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { IToolRegistry } from "memeloop";

const execFileAsync = promisify(execFile);
const todoStore = new Map<string, { id: string; content: string; status: string }>();

export function registerGenericNodeTools(registry: IToolRegistry): void {
  registry.registerTool("git", async (args: Record<string, unknown>) => gitImpl(args));
  registry.registerTool("webFetch", async (args: Record<string, unknown>) => webFetchImpl(args));
  registry.registerTool("todo", async (args: Record<string, unknown>) => todoImpl(args));
  registry.registerTool("summary", async (args: Record<string, unknown>) => summaryImpl(args));
}

// ─── Git (moved from memeloop core — needs git CLI) ───────────────────────────

const MAX_OUTPUT_LENGTH = 30_000;
const DEFAULT_TIMEOUT = 30_000;

const GIT_READONLY = new Set(["status", "diff", "log", "branch", "show", "remote", "tag"]);

function checkGitSafety(subcommand: string, args: string[]): string | null {
  if (subcommand === "push" && args.some((a) => a === "--force" || a === "-f")) {
    return "git push --force is blocked for safety.";
  }
  if (subcommand === "reset" && args.some((a) => a === "--hard")) {
    return "git reset --hard is blocked for safety.";
  }
  if (subcommand === "clean" && args.some((a) => a === "-f" || a === "--force")) {
    return "git clean -f is blocked for safety.";
  }
  return null;
}

function truncateOutput(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return text.slice(0, half) + "\n\n... [truncated] ...\n\n" + text.slice(-half);
}

async function gitImpl(args: Record<string, unknown>): Promise<unknown> {
  const subcommand = String(args.subcommand ?? "status").trim();
  const extraArgs = Array.isArray(args.args) ? args.args.filter((a): a is string => typeof a === "string") : [];
  const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
  const timeout = typeof args.timeout === "number" && args.timeout > 0 ? args.timeout : DEFAULT_TIMEOUT;

  const allowed = new Set([
    "status", "diff", "log", "branch", "add", "commit", "checkout",
    "clone", "pull", "push", "show", "stash", "merge", "rebase", "reset", "remote", "tag",
  ]);
  if (!allowed.has(subcommand)) {
    return { error: `Unsupported subcommand: ${subcommand}` };
  }

  const safety = checkGitSafety(subcommand, extraArgs);
  if (safety) {
    return { error: safety, blocked: true };
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      [subcommand, ...extraArgs],
      { cwd, timeout, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" } },
    );
    const parts: string[] = [];
    if (stdout) parts.push(truncateOutput(stdout.trimEnd(), MAX_OUTPUT_LENGTH));
    if (stderr) parts.push(`[stderr]\n${truncateOutput(stderr.trimEnd(), MAX_OUTPUT_LENGTH)}`);
    return {
      output: parts.join("\n") || "(no output)",
      isReadOnly: GIT_READONLY.has(subcommand),
      subcommand,
    };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    const parts: string[] = [];
    if (e.stdout) parts.push(truncateOutput(e.stdout.trimEnd(), MAX_OUTPUT_LENGTH));
    if (e.stderr) parts.push(`[stderr]\n${truncateOutput(e.stderr.trimEnd(), MAX_OUTPUT_LENGTH)}`);
    if (e.code) parts.push(`[exit code: ${e.code}]`);
    return {
      output: parts.join("\n") || "(error)",
      exitCode: e.code ?? 1,
      subcommand,
      isError: true,
    };
  }
}

// ─── WebFetch (moved from memeloop core) ──────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n").trim();
}

function htmlToMarkdown(html: string): string {
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
    .replace(/<p[^>]*>/g, "\n").replace(/<\/p>/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n").trim();
}

async function webFetchImpl(args: Record<string, unknown>): Promise<unknown> {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!url) return { error: "Missing 'url'" };

  const format = (typeof args.format === "string" ? args.format : "text") as "text" | "markdown" | "html";
  const timeout = typeof args.timeout === "number" && args.timeout > 0 ? args.timeout : undefined;

  try {
    const controller = new AbortController();
    const timer = timeout ? setTimeout(() => controller.abort(), timeout) : undefined;

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "MemeLoop/1.0 (WebFetch)" },
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

    const MAX_LENGTH = 100_000;
    const truncated = content.length > MAX_LENGTH
      ? content.slice(0, MAX_LENGTH) + `\n\n[... truncated at ${MAX_LENGTH}, total was ${content.length}]`
      : content;

    return {
      ok: response.ok,
      status: response.status,
      contentType,
      text: `Fetched: ${url}\nStatus: ${response.status}\nContent-Type: ${contentType}\n\n${truncated}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if ((err as Error).name === "AbortError") {
      return { error: `Web fetch timed out for ${url}` };
    }
    return { error: `Web fetch failed for ${url}: ${message}` };
  }
}

// ─── Todo ─────────────────────────────────────────────────────────────────────

async function todoImpl(args: Record<string, unknown>): Promise<unknown> {
  const action = String(args.action ?? "list");
  if (action === "list") return { todos: [...todoStore.values()] };
  if (action === "upsert") {
    const id = String(args.id ?? "").trim();
    const content = String(args.content ?? "");
    const status = String(args.status ?? "pending");
    if (!id) return { error: "Missing id" };
    todoStore.set(id, { id, content, status });
    return { ok: true, todo: todoStore.get(id) };
  }
  if (action === "remove") {
    const id = String(args.id ?? "").trim();
    todoStore.delete(id);
    return { ok: true };
  }
  return { error: "Unsupported action" };
}

async function summaryImpl(args: Record<string, unknown>): Promise<unknown> {
  const input = String(args.text ?? "");
  const maxLength = Math.max(32, Math.min(2000, Number(args.maxLength ?? 300)));
  const summary = input.length <= maxLength ? input : `${input.slice(0, maxLength - 3)}...`;
  return { summary, originalLength: input.length };
}
