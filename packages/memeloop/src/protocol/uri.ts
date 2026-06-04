/**
 * memeloop:// URI scheme for cross-node references (e.g. file.read without inlining bytes).
 * Format: memeloop://node/<nodeId>/file/<pathSegments...>
 * Path segments are percent-encoded per RFC 3986.
 */

export type MemeloopUriKind = "file";

export interface ParsedMemeloopFileUri {
  scheme: "memeloop";
  kind: "file";
  nodeId: string;
  /** Logical path on the holding node (slashes preserved, not leading slash). */
  filePath: string;
}

export type ParsedMemeloopUri = ParsedMemeloopFileUri;

const PREFIX = "memeloop://node/";

/**
 * Build `memeloop://node/<nodeId>/file/<encodedPath>` for a file on a node.
 */
export function buildMemeloopFileUri(nodeId: string, filePath: string): string {
  const normalized = filePath.replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean).map(encodeURIComponent);
  return `memeloop://node/${encodeURIComponent(nodeId)}/file/${segments.join("/")}`;
}

/** Alias for {@link buildMemeloopFileUri} (plan §22.2 / §16.8 `buildMemeloopUri`). */
export const buildMemeloopUri = buildMemeloopFileUri;

/**
 * Parse a memeloop URI. Currently only `.../file/...` is supported.
 */
export function parseMemeloopUri(uri: string): ParsedMemeloopUri | null {
  const u = uri.trim();
  if (!u.startsWith(PREFIX)) return null;
  const rest = u.slice(PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  let nodeId: string;
  try {
    nodeId = decodeURIComponent(rest.slice(0, slash));
  } catch {
    return null;
  }
  const afterNode = rest.slice(slash + 1);
  if (!afterNode.startsWith("file/")) return null;
  const pathPart = afterNode.slice("file/".length);
  if (pathPart.length === 0) {
    return { scheme: "memeloop", kind: "file", nodeId, filePath: "" };
  }
  try {
    const filePath = pathPart.split("/").map(decodeURIComponent).join("/");
    return { scheme: "memeloop", kind: "file", nodeId, filePath };
  } catch {
    return null;
  }
}
