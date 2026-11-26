/**
 * The former Markdown storage scanned and sorted every metadata/event file for
 * each read. That cannot satisfy MemeLoop v2's revisioned, byte-bounded,
 * keyset-indexed conversation contract, so it is deliberately unavailable.
 * SQLiteAgentStorage is the only production CLI conversation host.
 */

export interface MarkdownStorageOptions {
  rootDirectory: string;
}

export const MARKDOWN_CONVERSATION_STORAGE_V2_SUPPORTED = false as const;

export class MarkdownStorageV2UnsupportedError extends Error {
  public readonly code = 'MARKDOWN_STORAGE_V2_UNSUPPORTED';

  constructor() {
    super(
      'MarkdownAgentStorage is not a MemeLoop v2 conversation host; use SQLiteAgentStorage',
    );
    this.name = 'MarkdownStorageV2UnsupportedError';
  }
}

/** Compatibility entry point that reports the storage format's required v2 support. */
export function createMarkdownAgentStorage(_options: MarkdownStorageOptions): never {
  throw new MarkdownStorageV2UnsupportedError();
}
