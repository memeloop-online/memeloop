/**
 * fileHashStore.ts — Content hash cache for read-before-edit enforcement
 *
 * 对标 OpenCode / Claude Code：编辑文件前必须先用 read 工具读取。
 * read 时缓存文件的 content hash，edit 时校验旧内容是否匹配。
 */
import { createHash } from 'node:crypto';

interface HashEntry {
  hash: string;
  size: number;
  readAt: number; // timestamp
}

const store = new Map<string, HashEntry>();

const MAX_AGE_MS = 5 * 60 * 1000; // entries expire after 5 minutes

/** Compute sha256 hash of content */
function computeHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Record a read operation — stores content hash for later edit verification */
export function recordFileRead(filePath: string, content: string): void {
  store.set(filePath, {
    hash: computeHash(content),
    size: Buffer.byteLength(content, 'utf8'),
    readAt: Date.now(),
  });
}

/** Check if a file has been read recently and return its cached hash */
export function getReadHash(filePath: string): string | undefined {
  const entry = store.get(filePath);
  if (!entry) return undefined;

  // Expire old entries
  if (Date.now() - entry.readAt > MAX_AGE_MS) {
    store.delete(filePath);
    return undefined;
  }

  return entry.hash;
}

/** Verify that oldContent matches what was last read */
export function verifyReadHash(filePath: string, oldContent: string): boolean {
  const cachedHash = getReadHash(filePath);
  if (!cachedHash) return false; // file was never read
  const actualHash = computeHash(oldContent);
  return cachedHash === actualHash;
}

/** Clear all cached hashes (e.g., on /clear) */
export function clearHashStore(): void {
  store.clear();
}
