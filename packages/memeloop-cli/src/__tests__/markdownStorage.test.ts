import { describe, expect, it } from 'vitest';

import { createMarkdownAgentStorage, MARKDOWN_CONVERSATION_STORAGE_V2_SUPPORTED, MarkdownStorageV2UnsupportedError } from '../storage/markdownStorage.js';

describe('MarkdownAgentStorage', () => {
  it('is explicitly unavailable as a v2 conversation host', () => {
    expect(MARKDOWN_CONVERSATION_STORAGE_V2_SUPPORTED).toBe(false);
    expect(() => createMarkdownAgentStorage({ rootDirectory: '/not-used' }))
      .toThrow(MarkdownStorageV2UnsupportedError);
  });
});
