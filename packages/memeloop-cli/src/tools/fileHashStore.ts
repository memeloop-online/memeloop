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

const MAX_AGE_MS = 5 * 60 * 1000; // entries expire after 5 minutes
const MAX_ENTRIES = 1_024;

/** Compute sha256 hash of content */
function computeHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Record a read operation — stores content hash for later edit verification */
export class FileHashStore {
  private readonly store = new Map<string, HashEntry>();

  recordFileRead(filePath: string, content: string): void {
    const now = Date.now();
    for (const [path, entry] of this.store) {
      if (now - entry.readAt > MAX_AGE_MS) this.store.delete(path);
    }
    this.store.delete(filePath);
    while (this.store.size >= MAX_ENTRIES) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
    this.store.set(filePath, {
      hash: computeHash(content),
      size: Buffer.byteLength(content, 'utf8'),
      readAt: now,
    });
  }

  getReadHash(filePath: string): string | undefined {
    const entry = this.store.get(filePath);
    if (!entry) return undefined;

    if (Date.now() - entry.readAt > MAX_AGE_MS) {
      this.store.delete(filePath);
      return undefined;
    }

    return entry.hash;
  }

  verifyReadHash(filePath: string, oldContent: string): boolean {
    const cachedHash = this.getReadHash(filePath);
    if (!cachedHash) return false;
    return cachedHash === computeHash(oldContent);
  }

  clear(): void {
    this.store.clear();
  }
}

const standaloneFileHashStore = new FileHashStore();

export function recordFileRead(filePath: string, content: string): void {
  standaloneFileHashStore.recordFileRead(filePath, content);
}

/** Check if a file has been read recently and return its cached hash */
export function getReadHash(filePath: string): string | undefined {
  return standaloneFileHashStore.getReadHash(filePath);
}

/** Verify that oldContent matches what was last read */
export function verifyReadHash(filePath: string, oldContent: string): boolean {
  return standaloneFileHashStore.verifyReadHash(filePath, oldContent);
}

/** Clear all cached hashes (e.g., on /clear) */
export function clearHashStore(): void {
  standaloneFileHashStore.clear();
}
