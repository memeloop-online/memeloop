import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { ATTACHMENT_UPLOAD_LIMITS, buildAttachmentUploadChunkRequest, readConversationMessagePage } from '../device-network-entry.js';

describe('memeloop/device-network public entry', () => {
  it('declares the exact production package subpath', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { exports?: Record<string, unknown> };

    expect(packageJson.exports?.['./device-network']).toEqual({
      types: './dist/device-network/index.d.ts',
      import: './dist/device-network.js',
      require: './dist/device-network.cjs',
    });
  });

  it('exports the bounded conversation page reader from that entry', () => {
    expect(readConversationMessagePage).toBeTypeOf('function');
  });

  it('exports the portable bounded attachment chunk builder without a deep import', async () => {
    expect(ATTACHMENT_UPLOAD_LIMITS.chunkBytes).toBe(3 * 1_024 * 1_024);
    await expect(buildAttachmentUploadChunkRequest({
      requestId: 'request-1',
      conversationId: 'conversation-1',
      uploadId: 'upload-1',
      offset: 0,
      data: new Uint8Array([1, 2, 3]),
    })).resolves.toMatchObject({
      byteLength: 3,
      encoding: 'base64',
      data: 'AQID',
    });
  });
});
